using System.Globalization;
using System.Text.Json;
using Solarljos.Core;
using Solarljos.Text;

namespace Solarljos.Views.Folder;

/// <summary>
/// What the form for a folder held, kept to fill it in again and to start the plan again: the
/// folder as typed, only what is missing now, the day typed, and the places ticked (the page's
/// request for mode "folder", viewFolderForm and requestOf in src/gui/ui/app.js). `More` is only
/// whether its More options were open.
/// </summary>
public sealed record FolderRequest
{
    public string Folder { get; init; } = "";
    public bool DeletedOnly { get; init; }
    /// <summary>The day as typed; Since is that day's first moment, where the user is.</summary>
    public string SinceDate { get; init; } = "";
    public long? Since { get; init; }
    /// <summary>The places ticked, or null for every place.</summary>
    public IReadOnlyList<string>? Sources { get; init; }
    public bool More { get; init; }

    /// <summary>What the form held for a plan, as far as the engine echoes what it was asked (requestOf in app.js).</summary>
    public static FolderRequest FromEcho(JsonElement r)
    {
        if (r.ValueKind != JsonValueKind.Object) return new FolderRequest();
        long? since = r.TryGetProperty("since", out var s) && s.ValueKind == JsonValueKind.Number ? (long)s.GetDouble() : null;
        var sources = r.TryGetProperty("sources", out var src) && src.ValueKind == JsonValueKind.Array && src.GetArrayLength() > 0
            ? src.EnumerateArray().Select((x) => x.GetString() ?? "").ToList() : null;
        return new FolderRequest
        {
            Folder = r.TryGetProperty("folder", out var f) && f.ValueKind == JsonValueKind.String ? f.GetString() ?? "" : "",
            DeletedOnly = r.TryGetProperty("deletedOnly", out var d) && d.ValueKind == JsonValueKind.True,
            Since = since,
            SinceDate = since is { } ms ? Formats.Ymd(DateTimeOffset.FromUnixTimeMilliseconds(ms)) : "",
            Sources = sources,
            More = sources is not null,
        };
    }

    /// <summary>
    /// What a folder's plan sends (planBody in app.js): its choice of copy per file depends on the
    /// dates and on only-deleted; what is not set is left out, as the page's compact() leaves it.
    /// </summary>
    public Dictionary<string, object> Body(Session session)
    {
        var body = new Dictionary<string, object> { ["folder"] = Folder };
        if (DeletedOnly) body["deletedOnly"] = true;
        if (Since is { } since) body["since"] = since;
        if (Sources is { Count: > 0 } sources) body["sources"] = sources;
        body["locations"] = session.PlacesFor(null);
        return body;
    }

    /// <summary>
    /// Midnight where the user is at the start of a day written as year-month-day, 2026-09-01, as
    /// the command line reads --since and the page's box for a day gives it; null for a day written
    /// any other way -- 03/04/2026 is not the same day in every language -- or one that does not
    /// exist, such as 2026-02-30 (dayStart in app.js).
    /// </summary>
    public static long? DayStart(string typed)
    {
        if (!DateTime.TryParseExact((typed ?? "").Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)) return null;
        var midnight = DateTime.SpecifyKind(day.Date, DateTimeKind.Local);
        return new DateTimeOffset(midnight).ToUnixTimeMilliseconds();
    }

    /// <summary>Written as a day is, four digits, two and two, whether or not there is such a day.</summary>
    public static bool DayShaped(string s) =>
        s.Length == 10 && s[4] == '-' && s[7] == '-' && s.Where((c, i) => i is not (4 or 7)).All(char.IsAsciiDigit);
}
