using System.Net.Http;
using System.Text.Json;
using System.Windows;

namespace Solarljos.Core;

/// <summary>
/// What the program knows of the engine for this run: its client, what it said of itself
/// (api/info), the places it can search (api/sources), and its event stream, passed on to every
/// view that listens, on the window's thread. Nothing of it is kept on disk.
/// </summary>
public sealed class Session
{
    public CoreClient Client { get; }
    public JsonElement Info { get; private set; }
    public IReadOnlyList<SourceInfo> Sources { get; private set; } = [];
    public bool Elevated { get; private set; }
    /// <summary>The language the library speaks now, which what it says of a new job is in.</summary>
    public string? Locale { get; private set; }

    /// <summary>Each event of the stream by name, with its data, on the window's thread.</summary>
    public event Action<string, JsonElement>? Event;

    /// <summary>The stream broke; it is opened again by itself.</summary>
    public event Action? Gone;

    readonly CancellationTokenSource stop = new();

    public sealed record SourceInfo(string Id, string Label, bool Media, bool NeedsAdmin);

    /// <summary>Every search, plan and rebuild the engine has told of.</summary>
    public JobStore Jobs { get; }

    /// <summary>
    /// The places added for this run, sent with every search as search() takes them: whether this
    /// PC's own are searched too, and more folders by source id, as --location gives them. Kept in
    /// memory only, so they are gone when the program is.
    /// </summary>
    public bool Discover { get; set; } = true;
    public Dictionary<string, List<string>> Added { get; } = new();

    public int AddedCount => Added.Values.Sum((l) => l.Count);

    /// <summary>
    /// The places a search starts from: those added, and, for the folder a file was in, that folder
    /// looked through in every restore point (placesFor in app.js).
    /// </summary>
    public object PlacesFor(string? where)
    {
        var dirs = Added.Where((kv) => kv.Value.Count > 0).ToDictionary((kv) => kv.Key, (kv) => kv.Value.ToList());
        if (!string.IsNullOrEmpty(where))
        {
            if (!dirs.TryGetValue("vss", out var vss)) dirs["vss"] = vss = new List<string>();
            vss.Add("walk=" + where);
        }
        return new { discover = Discover, dirs };
    }

    public Session(CoreClient client)
    {
        Client = client;
        Jobs = new JobStore(this);
    }

    public async Task LoadAsync()
    {
        Info = await Client.GetAsync("/api/info");
        var s = await Client.GetAsync("/api/sources");
        Sources = s.GetProperty("sources").EnumerateArray().Select((x) => new SourceInfo(
            x.GetProperty("id").GetString()!, x.GetProperty("label").GetString()!,
            x.TryGetProperty("media", out var m) && m.ValueKind == JsonValueKind.True,
            x.TryGetProperty("needsAdmin", out var a) && a.ValueKind == JsonValueKind.True)).ToList();
        Locale = Info.TryGetProperty("locale", out var loc) && loc.ValueKind == JsonValueKind.String ? loc.GetString() : null;
        Elevated = (s.TryGetProperty("elevated", out var e) && e.ValueKind == JsonValueKind.True)
            || (Info.TryGetProperty("elevated", out var ie) && ie.ValueKind == JsonValueKind.True);
    }

    /// <summary>Starts listening to the event stream; it runs until Close().</summary>
    public void Listen()
    {
        var ui = Application.Current.Dispatcher;
        _ = Client.ListenAsync(
            (name, data) => ui.BeginInvoke(() => Event?.Invoke(name, data)),
            (_) => ui.BeginInvoke(() => Gone?.Invoke()),
            stop.Token);
    }

    /// <summary>Tells the engine the language chosen, so that what the library says is in it too.</summary>
    public async Task<string?> UseLanguageAsync(string code)
    {
        try
        {
            var r = await Client.PostAsync("/api/lang", new { lang = code });
            if (r.TryGetProperty("locale", out var l)) Locale = l.GetString();
            return Locale;
        }
        catch (Exception e) when (e is CoreException or HttpRequestException)
        {
            return null;
        }
    }

    public void Close() => stop.Cancel();
}
