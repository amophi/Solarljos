using System.Globalization;
using System.Text.RegularExpressions;
using Solarljos.Core;

namespace Solarljos.Text;

/// <summary>
/// Sizes, dates and the words for what a copy is, as the page writes them (src/gui/ui/app.js,
/// "strings and formats" and "what a copy is"), in the language chosen. Every time is local, as on
/// the command line.
/// </summary>
public static partial class Formats
{
    static Tr T => Tr.Instance;

    static readonly string[] SizeKeys = ["fmt.bytes", "fmt.kb", "fmt.mb", "fmt.gb", "fmt.tb"];

    /// <summary>A size as the command line prints one: whole bytes, then one decimal below 10 of a unit, in steps of 1024.</summary>
    public static string Size(long? n)
    {
        if (n is not { } bytes || bytes < 0) return T["fmt.sizeUnknown"];
        double v = bytes;
        int i = 0;
        while (v >= 1024 && i < SizeKeys.Length - 1)
        {
            v /= 1024;
            i++;
        }
        int digits = i == 0 ? 0 : v < 10 ? 1 : 0;
        var shown = v.ToString(digits == 0 ? "0" : "0.0", T.Culture);
        return T.Get(SizeKeys[i], ("n", shown));
    }

    /// <summary>A day as the language writes it with its month short: "27 Sept 2026", "2026년 9월 27일".</summary>
    public static string Day(DateTimeOffset? at) =>
        at is { } t ? t.ToLocalTime().ToString(DayPattern(), T.Culture) : T["fmt.dateUnknown"];

    /// <summary>A day and its time: "27 Sept 2026, 08:00".</summary>
    public static string When(DateTimeOffset? at) =>
        at is { } t ? t.ToLocalTime().ToString(DayPattern() + " " + T.Culture.DateTimeFormat.ShortTimePattern, T.Culture) : T["fmt.dateUnknown"];

    /// <summary>"2025-07" as the language names a month: "July 2025", "2025년 7월".</summary>
    public static string Month(string ym)
    {
        var p = ym.Split('-');
        if (p.Length != 2 || !int.TryParse(p[0], out int y) || !int.TryParse(p[1], out int m)) return ym;
        return new DateTime(y, m, 1).ToString(T.Culture.DateTimeFormat.YearMonthPattern, T.Culture);
    }

    /// <summary>The local month a time falls in, as "2025-07"; null for none.</summary>
    public static string? MonthOf(DateTimeOffset? at) => at is { } t ? t.ToLocalTime().ToString("yyyy-MM", CultureInfo.InvariantCulture) : null;

    /// <summary>A local date as YYYY-MM-DD.</summary>
    public static string Ymd(DateTimeOffset at) => at.ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>A local time as "2026-09-28 14.32", which a folder name can hold on every system.</summary>
    public static string Stamp(DateTimeOffset at) => at.ToLocalTime().ToString("yyyy-MM-dd HH.mm", CultureInfo.InvariantCulture);

    /// <summary>The culture's long date without its weekday and with its month short: the medium date Intl writes.</summary>
    static string DayPattern()
    {
        var f = T.Culture.DateTimeFormat;
        var p = WeekdayPart().Replace(f.LongDatePattern, "").Trim(' ', ',', '،');
        return p.Replace("MMMM", "MMM");
    }

    [GeneratedRegex(@"\s*,?\s*dddd\s*,?\s*")]
    private static partial Regex WeekdayPart();

    /// <summary>Things in a row as the language joins them: "a, b and c" in English, "a, b, c" otherwise.</summary>
    public static string List(IEnumerable<string> items)
    {
        var list = items.ToList();
        if (list.Count <= 1) return string.Join("", list);
        if (T.Code == "en") return string.Join(", ", list.Take(list.Count - 1)) + " and " + list[^1];
        return string.Join(T.Code is "ja" or "zh-CN" or "zh-TW" ? "、" : ", ", list);
    }

    // ---- what a copy is ----------------------------------------------------------------------

    /// <summary>The words for a copy's quality, its size when it is a smaller copy.</summary>
    public static string TierText(Copy c)
    {
        var t = c.Tier;
        if (t == "derived" && c.Width is { } w && c.Height is { } h) return T.Get("tier.derived.size", ("w", w), ("h", h));
        return T["tier." + t];
    }

    /// <summary>What a copy's quality means for this copy.</summary>
    public static string TierHelp(Copy c) => c.Tier == "inexact"
        ? T[c.FromDisk ? "tier.inexact.help.disk" : "tier.inexact.help.text"]
        : T[$"tier.{c.Tier}.help"];

    /// <summary>The icon beside a tier's words, never instead of them.</summary>
    public static string TierIcon(string tier) => tier switch
    {
        "exact" => "check",
        "inexact" => "approx",
        "draft" => "pencil",
        "unverified" => "alert",
        "derived" => "shrink",
        "folder" => "folder",
        _ => "slash",
    };

    static string StateKey(string state) => state switch
    {
        "deleted" => "state.deleted",
        "exists" => "state.exists",
        "no content" => "state.noContent",
        _ => "state.unknown",
    };

    public static string StateText(string state) => T[StateKey(state)];
    public static string StateHelp(string state) => T[StateKey(state) + ".help"];

    /// <summary>When a copy is from, said as what its date means: "Deleted on 27 Sept 2026, 08:00".</summary>
    public static string TimeText(Copy c) => c.When is { } at ? T.Get("time." + c.TimeMeaning, ("date", When(at))) : T["time.none"];

    public static string KindLabel(string kind, string? fallback = null) =>
        T.Has("kind." + kind) ? T["kind." + kind] : fallback ?? kind;

    public static string KindHelp(string kind, string? source) =>
        T.Has("kindHelp." + kind) ? T["kindHelp." + kind] : T.Get("kind.unknownHelp", ("source", source ?? kind));

    /// <summary>A place searched by its id, as the page names it; the engine's label where the page has none.</summary>
    public static string SourceLabel(string id, string? fallback = null)
    {
        if (T.Has($"source.{id}.label")) return T[$"source.{id}.label"];
        var s = App.Session?.Sources.FirstOrDefault((x) => x.Id == id);
        return s?.Label ?? fallback ?? id;
    }

    /// <summary>A format as people name it: JPG, HEIC, MP4.</summary>
    public static string FormatName(string? ext)
    {
        var e = (ext ?? "").TrimStart('.');
        return e.Length > 0 ? e.ToUpperInvariant() : T["common.unknown"];
    }

    // ---- what went wrong ---------------------------------------------------------------------

    static readonly Dictionary<string, string> Errno = new()
    {
        ["ENOSPC"] = "error.io.ENOSPC", ["EACCES"] = "error.io.EACCES", ["EPERM"] = "error.io.EPERM",
        ["ENAMETOOLONG"] = "error.io.ENAMETOOLONG", ["ENOENT"] = "error.io.ENOENT", ["EIO"] = "error.io.EIO",
        ["EROFS"] = "error.io.EROFS", ["EBUSY"] = "error.io.EBUSY", ["EEXIST"] = "error.io.EEXIST",
    };

    static readonly Dictionary<int, string> Status = new()
    {
        [400] = "error.usage", [404] = "error.notFound", [409] = "error.busy", [410] = "error.gone", [413] = "error.tooLarge", [415] = "error.format",
    };

    /// <summary>
    /// What went wrong, for the person using the program: the engine's own sentence when it has one,
    /// and for a system error, such as a full disk, what it means (errorText in app.js).
    /// </summary>
    public static string ErrorText(Exception? e)
    {
        if (e is null) return T["error.unexpected"];
        if (e is HttpRequestException or TaskCanceledException) return T["error.offline"];
        if (e is not CoreException ce) return T["error.unexpected"];
        if (ce.Status == 403) return T["error.forbidden"];
        var message = ce.Message ?? "";
        var errno = ce.Code;
        if (errno is null && ErrnoIn().Match(message) is { Success: true } m) errno = m.Groups[1].Value;
        if (errno is not null && Errno.TryGetValue(errno, out var key)) return T[key];
        if (ce.Status >= 500) return T.Get("error.io", ("message", message));
        if (message.Length > 0) return message;
        return T[Status.TryGetValue(ce.Status, out var sk) ? sk : "error.unexpected"];
    }

    [GeneratedRegex(@"\b(E[A-Z][A-Z0-9]+)\b")]
    private static partial Regex ErrnoIn();
}
