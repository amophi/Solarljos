using System.Globalization;
using System.Text.Json;
using Solarljos.Core;
using Solarljos.Text;

namespace Solarljos.Views.Media;

/// <summary>
/// What the form for photos and videos holds (viewMediaForm's values() in src/gui/ui/app.js):
/// what to look for, from when, where, and the smaller copies. It is sent with the search as
/// `view`, which the engine keeps and gives back as it came, so that the grid knows the dates and
/// the folder chosen and a search can be made again from it; the engine reads only the types and
/// the places of it.
/// </summary>
public sealed class MediaRequest
{
    public List<string> Types { get; set; } = ["image", "video"];
    public string WhenChoice { get; set; } = "any";
    /// <summary>A day as YYYY-MM-DD, the form a date box holds; "" for none.</summary>
    public string FromDate { get; set; } = "";
    public string ToDate { get; set; } = "";
    public string Where { get; set; } = "";
    public bool IncludeSmaller { get; set; } = true;
    public bool IncludeWeb { get; set; }
    /// <summary>The places ticked; null for all of them.</summary>
    public List<string>? Sources { get; set; }
    /// <summary>The first and last moment kept, in ms; null for no limit (mediaRange).</summary>
    public long? From { get; set; }
    public long? To { get; set; }
    /// <summary>Not sent: whether More options was open, for a form made again.</summary>
    public bool More { get; set; }
    /// <summary>Not sent: a day typed that could not be read, for a form made again.</summary>
    public bool FromBad { get; set; }
    public bool ToBad { get; set; }

    public MediaRequest Clone() => new()
    {
        Types = Types.ToList(), WhenChoice = WhenChoice, FromDate = FromDate, ToDate = ToDate, Where = Where,
        IncludeSmaller = IncludeSmaller, IncludeWeb = IncludeWeb, Sources = Sources?.ToList(), From = From, To = To, More = More,
        FromBad = FromBad, ToBad = ToBad,
    };

    /// <summary>The form as it is sent with the search: every field, those not set as null, as the page's JSON has them.</summary>
    public Dictionary<string, object?> ToView() => new()
    {
        ["mode"] = "media",
        ["types"] = Types.ToArray(),
        ["whenChoice"] = WhenChoice,
        ["fromDate"] = FromDate,
        ["toDate"] = ToDate,
        ["where"] = Where,
        ["includeSmaller"] = IncludeSmaller,
        ["includeWeb"] = IncludeWeb,
        ["sources"] = Sources?.ToArray(),
        ["from"] = From,
        ["to"] = To,
    };

    /// <summary>
    /// What a search for photos sends (searchBody in app.js): the types, the places and where to
    /// start from, and the form itself as `view`; what is not set is left out.
    /// </summary>
    public object Body(Session session)
    {
        var body = new Dictionary<string, object?>();
        if (Types.Count > 0) body["types"] = Types.ToArray();
        if (Sources is { Count: > 0 }) body["sources"] = Sources.ToArray();
        body["locations"] = session.PlacesFor(Where.Length > 0 ? Where : null);
        body["view"] = ToView();
        return body;
    }

    /// <summary>
    /// What a job of the grid was asked for (requestOf in app.js): the form it was sent with, or,
    /// for one the program did not send itself, what the engine kept of it.
    /// </summary>
    public static MediaRequest Of(Job job)
    {
        var r = job.Request;
        if (r.ValueKind == JsonValueKind.Object && r.TryGetProperty("view", out var v) && v.ValueKind == JsonValueKind.Object
            && Str(v, "mode") == "media")
        {
            return FromView(v);
        }
        var req = new MediaRequest { IncludeSmaller = true };
        if (r.ValueKind == JsonValueKind.Object)
        {
            req.Types = List(r, "types") ?? ["image", "video"];
            req.Sources = List(r, "sources") is { Count: > 0 } s ? s : null;
        }
        return req;
    }

    public static MediaRequest FromView(JsonElement v) => new()
    {
        Types = List(v, "types") ?? [],
        WhenChoice = Str(v, "whenChoice") ?? "any",
        FromDate = Str(v, "fromDate") ?? "",
        ToDate = Str(v, "toDate") ?? "",
        Where = Str(v, "where") ?? "",
        IncludeSmaller = !(v.TryGetProperty("includeSmaller", out var s) && s.ValueKind == JsonValueKind.False),
        IncludeWeb = v.TryGetProperty("includeWeb", out var w) && w.ValueKind == JsonValueKind.True,
        Sources = List(v, "sources") is { Count: > 0 } src ? src : null,
        From = Num(v, "from"),
        To = Num(v, "to"),
    };

    static string? Str(JsonElement o, string k) => o.TryGetProperty(k, out var x) && x.ValueKind == JsonValueKind.String ? x.GetString() : null;

    static long? Num(JsonElement o, string k) => o.TryGetProperty(k, out var x) && x.ValueKind == JsonValueKind.Number ? (long)x.GetDouble() : null;

    static List<string>? List(JsonElement o, string k) => o.TryGetProperty(k, out var x) && x.ValueKind == JsonValueKind.Array
        ? x.EnumerateArray().Where((e) => e.ValueKind == JsonValueKind.String).Select((e) => e.GetString()!).ToList() : null;

    // ---- dates -----------------------------------------------------------------------------------

    /// <summary>
    /// Midnight where the person is at the start of a YYYY-MM-DD day, in ms; with `after`, the last
    /// millisecond of that day. Null for a day that does not exist, such as 2026-02-30 (dayStart).
    /// </summary>
    public static long? DayStart(string? s, bool after = false)
    {
        if (string.IsNullOrEmpty(s) || !DateTime.TryParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)) return null;
        var start = new DateTime(day.Year, day.Month, day.Day, 0, 0, 0, DateTimeKind.Local);
        return after ? new DateTimeOffset(start.AddDays(1)).ToUnixTimeMilliseconds() - 1 : new DateTimeOffset(start).ToUnixTimeMilliseconds();
    }

    /// <summary>
    /// The dates a photo search keeps, either of them null for no limit; a day given as the end is
    /// kept whole. Null when a day picked cannot be read, none is, or they are the wrong way round
    /// (mediaRange).
    /// </summary>
    public static (long? From, long? To)? Range(string choice, string from, string to, DateTime? now = null)
    {
        int y = (now ?? DateTime.Now).Year;
        long Jan1(int year) => new DateTimeOffset(new DateTime(year, 1, 1, 0, 0, 0, DateTimeKind.Local)).ToUnixTimeMilliseconds();
        if (choice == "thisYear") return (Jan1(y), null);
        if (choice == "lastYear") return (Jan1(y - 1), Jan1(y) - 1);
        if (choice != "pick") return (null, null);
        long? f = from.Length > 0 ? DayStart(from) : null;
        long? t = to.Length > 0 ? DayStart(to, true) : null;
        if ((from.Length > 0 && f is null) || (to.Length > 0 && t is null) || (f is null && t is null)) return null;
        if (f is not null && t is not null && f > t) return null;
        return (f, t);
    }
}

/// <summary>
/// What the grid works out of the copies it holds (src/gui/ui/app.js, filterMedia, mediaCounts,
/// groupByMonth, monthCounts): which its choices keep and how many each hides, how many photos and
/// videos there are, and the months they fall in.
/// </summary>
public static class MediaData
{
    /// <summary>Photos shown at a time (GRID_PAGE); fewer only for a picture of the window, whose made-up library is small.</summary>
    public static int GridPage { get; set; } = 240;
    /// <summary>"Hide tiny pictures" hides those smaller than this on both sides (TINY_PX).</summary>
    public const int TinyPx = 64;

    public sealed record Choices(bool Smaller, bool HideTiny, string Source, bool AllDates, bool AllPlaces, long? From, long? To, string Where);

    public sealed record Hidden(int Elsewhere, int OutsideDates, int Smaller, int Tiny, int Source)
    {
        public int Total => Elsewhere + OutsideDates + Smaller + Tiny + Source;
    }

    /// <summary>
    /// The photos and videos the grid keeps under its choices, and how many each hides. Copies that
    /// carry no date are always kept, whatever the dates: a thumbnail whose file is unknown has
    /// none, and may be the one picture left.
    /// </summary>
    public static (List<Copy> Kept, Hidden Hidden) Filter(IEnumerable<Copy> items, Choices f)
    {
        int elsewhere = 0, dates = 0, smaller = 0, tiny = 0, source = 0;
        var kept = new List<Copy>();
        foreach (var c in items)
        {
            if (f.Where.Length > 0 && !f.AllPlaces && c.Path is { Length: > 0 } p && !Paths.IsInside(p, f.Where))
            {
                elsewhere++;
                continue;
            }
            if (!f.AllDates && c.Time is { } t && double.IsFinite(t) && ((f.From is { } from && t < from) || (f.To is { } to && t > to)))
            {
                dates++;
                continue;
            }
            if (!f.Smaller && c.Tier == "derived")
            {
                smaller++;
                continue;
            }
            if (f.HideTiny && c.Width is > 0 and var w && c.Height is > 0 and var h && w < TinyPx && h < TinyPx)
            {
                tiny++;
                continue;
            }
            if (f.Source.Length > 0 && c.Source != f.Source)
            {
                source++;
                continue;
            }
            kept.Add(c);
        }
        return (kept, new Hidden(elsewhere, dates, smaller, tiny, source));
    }

    public static bool IsVideo(Copy c) => c.Media == "video";

    /// <summary>How many photos, videos and smaller copies a list holds.</summary>
    public static (int Photos, int Videos, int Smaller) Counts(IEnumerable<Copy> items)
    {
        int photos = 0, videos = 0, smaller = 0;
        foreach (var c in items)
        {
            if (IsVideo(c)) videos++;
            else photos++;
            if (c.Tier == "derived") smaller++;
        }
        return (photos, videos, smaller);
    }

    /// <summary>The local month a copy's date falls in, as "2025-07"; null for one with no date.</summary>
    public static string? MonthOf(Copy c) => Formats.MonthOf(c.When);

    /// <summary>How many copies fall in each month, in the order the months first come; the undated as month null.</summary>
    public static List<(string? Month, int Count)> MonthCounts(IEnumerable<Copy> items)
    {
        var order = new List<string?>();
        var counts = new Dictionary<string, int>();
        foreach (var c in items)
        {
            var m = MonthOf(c);
            var key = m ?? "";
            if (!counts.TryGetValue(key, out int n)) order.Add(m);
            counts[key] = n + 1;
        }
        return order.Select((m) => (m, counts[m ?? ""])).ToList();
    }

    /// <summary>A tile's words for assistive technology: what it is, its name, when, which copy and how large (tileLabel).</summary>
    public static string TileLabel(Copy c)
    {
        var T = Tr.Instance;
        var type = T[IsVideo(c) ? "grid.type.video" : "grid.type.photo"];
        var when = c.When is { } at ? Formats.Day(at) : T["grid.noDate"];
        var args = new (string, object?)[] { ("type", type), ("name", c.Name), ("when", when), ("tier", Formats.TierText(c)), ("size", Formats.Size(c.Size)) };
        return c.Name is { Length: > 0 } ? T.Get("grid.tileLabelNamed", args) : T.Get("grid.tileLabel", args);
    }

    /// <summary>What is known of a copy in a line: its date as what it means, its size, its size in pixels (metaLine).</summary>
    public static string MetaLine(Copy c)
    {
        var parts = new List<string> { Formats.TimeText(c) };
        if (!c.IsDir) parts.Add(Formats.Size(c.Size));
        if (c.Width is > 0 && c.Height is > 0) parts.Add(Tr.Instance.Get("fmt.dimensions", ("w", c.Width), ("h", c.Height)));
        return string.Join(" · ", parts);
    }

    /// <summary>Where a copy was found, and in how many places more (foundIn).</summary>
    public static string FoundIn(Copy c)
    {
        var kind = Formats.KindLabel(c.Kind, c.KindLabel);
        return c.Copies > 1 ? Tr.Instance.Get("results.foundInMany", ("kind", kind), ("count", c.Copies - 1)) : kind;
    }

    /// <summary>A field of the copy as the engine sent it, which Copy does not carry: its short id, the kinds it was also seen in.</summary>
    public static string? RawString(Copy c, string key) =>
        c.Raw.ValueKind == JsonValueKind.Object && c.Raw.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public static List<string> RawList(Copy c, string key) =>
        c.Raw.ValueKind == JsonValueKind.Object && c.Raw.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Where((e) => e.ValueKind == JsonValueKind.String).Select((e) => e.GetString()!).ToList() : [];
}
