using System.Globalization;
using System.Text.Json;
using Solarljos.Core;

namespace Solarljos.Views.Find;

/// <summary>
/// What the form of Find a file holds, as the page keeps it (viewFindForm's values in app.js):
/// the name, the folder, the words, only-deleted, the dates, the kind of file and the places. It
/// is sent with the search as `view`, which the engine keeps with it and gives back as it came,
/// so that a search by name keeps its own results apart from one for photos, and the results
/// know what was asked; `Since` is the first time kept, in ms, worked out when it was sent.
/// </summary>
public sealed record FindRequest
{
    public string Name { get; init; } = "";
    public string Containing { get; init; } = "";
    public string Where { get; init; } = "";
    public bool DeletedOnly { get; init; }
    /// <summary>"any", "day", "week", "month" or "pick".</summary>
    public string SinceChoice { get; init; } = "any";
    /// <summary>The day chosen, as YYYY-MM-DD; "" for none.</summary>
    public string SinceDate { get; init; } = "";
    public List<string> Types { get; init; } = [];
    /// <summary>The places ticked; null for all of them.</summary>
    public List<string>? Sources { get; init; }
    public double? Since { get; init; }

    // Not sent: how the form was left, for when it is made again.
    /// <summary>Whether More options was open; null when the form has not been seen since.</summary>
    public bool? More { get; init; }
    /// <summary>The box to start in when the form is next shown: "containing".</summary>
    public string? Focus { get; init; }

    /// <summary>The first time a "since" choice keeps, in ms: 24 hours, 7 or 30 days back, or a chosen day's local midnight.</summary>
    public static double? SinceMs(string choice, string picked, DateTimeOffset? now = null)
    {
        double at = (now ?? DateTimeOffset.UtcNow).ToUnixTimeMilliseconds();
        const double day = 86400000;
        return choice switch
        {
            "day" => at - day,
            "week" => at - 7 * day,
            "month" => at - 30 * day,
            "pick" => DayStart(picked),
            _ => null,
        };
    }

    /// <summary>Midnight where the user is at the start of a YYYY-MM-DD day, in ms; null for a day that does not exist.</summary>
    public static double? DayStart(string s)
    {
        if (!DateTime.TryParseExact(s ?? "", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)) return null;
        var local = DateTime.SpecifyKind(d, DateTimeKind.Local);
        return new DateTimeOffset(local).ToUnixTimeMilliseconds();
    }

    /// <summary>The form as `view`: every choice in it, as the page sends it.</summary>
    public Dictionary<string, object?> View() => new()
    {
        ["mode"] = "name",
        ["name"] = Name,
        ["containing"] = Containing,
        ["where"] = Where,
        ["deletedOnly"] = DeletedOnly,
        ["sinceChoice"] = SinceChoice,
        ["sinceDate"] = SinceDate,
        ["types"] = Types,
        ["sources"] = Sources,
        ["since"] = Since,
    };

    /// <summary>
    /// What a search by name sends (searchBody in app.js): only what decides which copies are
    /// found, and the form as it was. Fields that are not set are left out.
    /// </summary>
    public Dictionary<string, object?> Body(Session session)
    {
        var body = new Dictionary<string, object?>();
        if (Name.Length > 0) body["pattern"] = Name;
        if (Containing.Length > 0) body["containing"] = Containing;
        if (Types.Count > 0) body["types"] = Types;
        if (Sources is { Count: > 0 }) body["sources"] = Sources;
        body["locations"] = session.PlacesFor(Where.Length > 0 ? Where : null);
        body["view"] = View();
        return body;
    }

    static string Str(JsonElement o, string k) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    static List<string>? List(JsonElement o, string k) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Where((x) => x.ValueKind == JsonValueKind.String).Select((x) => x.GetString()!).ToList() : null;

    /// <summary>
    /// What the form held for a job, as far as the engine kept its request (requestOf in app.js):
    /// the form as it was sent, when it was; else what was searched for.
    /// </summary>
    public static FindRequest Of(Job job)
    {
        var r = job.Request;
        if (r.ValueKind == JsonValueKind.Object && r.TryGetProperty("view", out var v) && v.ValueKind == JsonValueKind.Object && Str(v, "mode") == "name")
        {
            return new FindRequest
            {
                Name = Str(v, "name"),
                Containing = Str(v, "containing"),
                Where = Str(v, "where"),
                DeletedOnly = v.TryGetProperty("deletedOnly", out var d) && d.ValueKind == JsonValueKind.True,
                SinceChoice = Str(v, "sinceChoice") is { Length: > 0 } sc ? sc : "any",
                SinceDate = Str(v, "sinceDate"),
                Types = List(v, "types") ?? [],
                Sources = List(v, "sources") is { Count: > 0 } s ? s : null,
                Since = v.TryGetProperty("since", out var t) && t.ValueKind == JsonValueKind.Number ? t.GetDouble() : null,
            };
        }
        return new FindRequest
        {
            Name = Str(r, "pattern"),
            Containing = Str(r, "containing"),
            Types = List(r, "types") ?? [],
            Sources = List(r, "sources") is { Count: > 0 } s2 ? s2 : null,
        };
    }
}
