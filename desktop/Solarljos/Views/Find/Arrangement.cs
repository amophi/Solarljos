using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Solarljos.Core;
using Solarljos.Text;

namespace Solarljos.Views.Find;

/// <summary>
/// The copies of one file: by path -- a folder apart from a file of the same name -- or by name
/// alone when the folder is unknown; a copy with neither is a group of its own. Its best copy,
/// `Newer` when a copy newer than that one exists that is less certain (a draft, say), and every
/// copy newest first.
/// </summary>
public sealed class FileGroup
{
    public required string Key { get; init; }
    public required List<Copy> Versions { get; init; }
    public required Copy Best { get; init; }
    public Copy? Newer { get; init; }
    public string? Name { get; init; }
    public string? Folder { get; init; }
    public string State { get; init; } = "";
    public bool IsDir { get; init; }
    /// <summary>The time of its newest copy, in ms; null when that carries none.</summary>
    public double? Time { get; init; }
}

/// <summary>What the filters of the results keep, and how many copies each of them hides.</summary>
public sealed record Filtered(List<Copy> Kept, int Elsewhere, int NotDeleted, int OutsideDates, int Undated);

/// <summary>
/// The results as the page arranges them (src/gui/ui/app.js, "results, as the page arranges
/// them"): grouped by file, sorted as Sort chooses, filtered by what is chosen on the results.
/// </summary>
public static partial class Arrangement
{
    static double? WhenOf(Copy c) => c.Time is { } t && double.IsFinite(t) ? t : null;

    /// <summary>Copies grouped by the file they are of (groupFiles in app.js), in the order the files first come.</summary>
    public static List<FileGroup> GroupFiles(IEnumerable<Copy> items)
    {
        var order = new List<string>();
        var groups = new Dictionary<string, List<Copy>>();
        foreach (var c in items)
        {
            var key = c.Path is { Length: > 0 } p ? $"{(c.IsDir ? "dir" : "file")}:{Paths.Key(p)}"
                : c.RawName is { Length: > 0 } n ? $"name:{n.Normalize(NormalizationForm.FormC).ToLowerInvariant()}" : $"uid:{c.Uid}";
            if (!groups.TryGetValue(key, out var list))
            {
                groups[key] = list = new List<Copy>();
                order.Add(key);
            }
            list.Add(c);
        }
        var out_ = new List<FileGroup>(order.Count);
        foreach (var key in order)
        {
            var list = groups[key];
            var best = list[0];
            foreach (var c in list) if (c.Better(best)) best = c;
            // Stable, so copies of one moment keep the library's order.
            var versions = list.OrderByDescending((c) => c.TimeOr).ToList();
            var newest = versions[0];
            out_.Add(new FileGroup
            {
                Key = key,
                Versions = versions,
                Best = best,
                Newer = newest != best && newest.TimeOr > best.TimeOr ? newest : null,
                Name = best.Name,
                Folder = best.Folder,
                State = best.State,
                IsDir = best.IsDir,
                Time = WhenOf(newest),
            });
        }
        return out_;
    }

    /// <summary>Names as people sort them: in the language's order, case and accents aside, numbers by their value.</summary>
    public static int ByName(string? a, string? b)
    {
        var culture = Tr.Instance.Culture;
        const CompareOptions loose = CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace | CompareOptions.IgnoreKanaType | CompareOptions.IgnoreWidth;
        try
        {
            return culture.CompareInfo.Compare(a ?? "", b ?? "", loose | CompareOptions.NumericOrdering);
        }
        catch (ArgumentException)
        {
            return culture.CompareInfo.Compare(a ?? "", b ?? "", loose);
        }
    }

    /// <summary>Undated ones last whichever way; else by time, `dir` -1 for the newest first.</summary>
    static int UndatedLast(double? ta, double? tb, int dir)
    {
        if (ta is null || tb is null) return (ta is null ? 1 : 0) - (tb is null ? 1 : 0);
        return dir * Math.Sign(ta.Value - tb.Value);
    }

    /// <summary>File groups sorted as the results' Sort chooses (sortRows in app.js); stable.</summary>
    public static List<FileGroup> Sort(IEnumerable<FileGroup> rows, string how) =>
        SortBy(rows, how, (g) => g.Time, (g) => g.Best.Size, (g) => g.Name, (g) => g.Folder);

    /// <summary>Single copies sorted the same way.</summary>
    public static List<Copy> Sort(IEnumerable<Copy> rows, string how) =>
        SortBy(rows, how, WhenOf, (c) => c.Size, (c) => c.Name, (c) => c.Folder);

    static List<T> SortBy<T>(IEnumerable<T> rows, string how, Func<T, double?> time, Func<T, long?> size, Func<T, string?> name, Func<T, string?> folder)
    {
        Comparison<T> cmp = how switch
        {
            "oldest" => (a, b) => UndatedLast(time(a), time(b), 1),
            "name" => (a, b) =>
            {
                int n = ByName(name(a), name(b));
                if (n == 0) n = ByName(folder(a), folder(b));
                return n != 0 ? n : UndatedLast(time(a), time(b), -1);
            },
            "size" => (a, b) =>
            {
                int s = (size(b) ?? -1).CompareTo(size(a) ?? -1);
                return s != 0 ? s : UndatedLast(time(a), time(b), -1);
            },
            _ => (a, b) => UndatedLast(time(a), time(b), -1),
        };
        return rows.OrderBy((x) => x, Comparer<T>.Create(cmp)).ToList();
    }

    /// <summary>Whether a copy's path, or its name, holds the words typed in the filter box.</summary>
    public static bool MatchesText(Copy c, string? q)
    {
        var s = (q ?? "").ToLowerInvariant();
        return s.Length == 0 || (c.Path ?? c.RawName ?? "").ToLowerInvariant().Contains(s, StringComparison.Ordinal);
    }

    /// <summary>
    /// The copies a search by name keeps under the choices on its page, and how many each choice
    /// hides (filterResults in app.js). `since` keeps copies that carry no time, as search()
    /// does, and counts them; `where` keeps copies whose folder is unknown, since they may have
    /// been there.
    /// </summary>
    public static Filtered Filter(IEnumerable<Copy> items, bool deletedOnly, double? since, bool allDates, string? where, bool allPlaces, string? q)
    {
        int elsewhere = 0, notDeleted = 0, outsideDates = 0, undated = 0;
        var kept = new List<Copy>();
        foreach (var c in items)
        {
            if (!string.IsNullOrEmpty(where) && !allPlaces && c.Path is { Length: > 0 } p && !Paths.IsInside(p, where))
            {
                elsewhere++;
                continue;
            }
            if (deletedOnly && c.State != "deleted")
            {
                notDeleted++;
                continue;
            }
            if (since is { } from && !allDates)
            {
                if (WhenOf(c) is not { } t) undated++;
                else if (t < from)
                {
                    outsideDates++;
                    continue;
                }
            }
            if (!string.IsNullOrEmpty(q) && !MatchesText(c, q)) continue;
            kept.Add(c);
        }
        return new Filtered(kept, elsewhere, notDeleted, outsideDates, undated);
    }

    /// <summary>
    /// A shorter word to search for when a name found nothing: the longest word of three letters
    /// or more in it, "budget" for budget-final-v2.xlsx. Null when there is none, or for a glob.
    /// </summary>
    public static string? PartOfName(string? name)
    {
        var s = (name ?? "").Trim();
        if (s.Length == 0 || s.IndexOfAny(['*', '?']) >= 0) return null;
        var stem = Extension().Replace(s, "");
        var words = WordBreaks().Split(stem).Where((w) => w.Length >= 3).OrderByDescending((w) => w.Length).ToList();
        if (words.Count > 0 && !string.Equals(words[0], s, StringComparison.OrdinalIgnoreCase)) return words[0];
        return stem.Length > 0 && stem != s ? stem : null;
    }

    [GeneratedRegex(@"\.[^.\\/]*$")] private static partial Regex Extension();
    [GeneratedRegex(@"[\s._\-()\[\]{},]+")] private static partial Regex WordBreaks();

    /// <summary>
    /// What can go wrong in asking the engine: what it answered, no answer at all, an answer that
    /// took too long or broke off, or one that could not be read. Each is said in words, never a crash.
    /// </summary>
    public static bool IsTrouble(Exception e) =>
        e is CoreException or HttpRequestException or TaskCanceledException or System.IO.IOException or JsonException;

    // ---- what the page says of a copy -------------------------------------------------------

    static Tr T => Tr.Instance;

    /// <summary>The place a copy was found in, and how many more had it.</summary>
    public static string FoundIn(Copy c)
    {
        var kind = Formats.KindLabel(c.Kind, c.KindLabel);
        return c.Copies > 1 ? T.Get("results.foundInMany", ("kind", kind), ("count", c.Copies - 1)) : kind;
    }

    /// <summary>When it is from, how large, how many pixels: "Deleted on 27 Sept 2026, 08:00 · 48 KB".</summary>
    public static string MetaLine(Copy c)
    {
        var parts = new List<string> { Formats.TimeText(c) };
        if (!c.IsDir) parts.Add(Formats.Size(c.Size));
        if (c.Width is { } w && c.Height is { } h && w > 0 && h > 0) parts.Add(T.Get("fmt.dimensions", ("w", w), ("h", h)));
        return string.Join(" · ", parts);
    }

    /// <summary>The icon of a kind of file, for the eye: a folder, a picture, a video, or a page.</summary>
    public static string FileIcon(Copy c) => c.IsDir ? "folder" : c.Media switch { "image" => "photo", "video" => "video", _ => "file" };

    /// <summary>
    /// A path, as it is written: left to right in any language, its letters in Pretendard before
    /// the language's own font, as the page draws them, so that a backslash is one even where a
    /// Japanese font would draw it as a yen sign.
    /// </summary>
    public static T2 AsPath<T2>(this T2 tb) where T2 : System.Windows.Controls.TextBlock
    {
        tb.FlowDirection = System.Windows.FlowDirection.LeftToRight;
        tb.HorizontalAlignment = System.Windows.HorizontalAlignment.Left;
        tb.FontFamily = PathFont;
        return tb;
    }

    static System.Windows.Media.FontFamily PathFont => new(new Uri("pack://application:,,,/"), Tr.Instance.Code switch
    {
        "ja" => "./Fonts/#Pretendard, Yu Gothic UI, Meiryo UI, Segoe UI",
        "zh-CN" => "./Fonts/#Pretendard, Microsoft YaHei UI, Segoe UI",
        "zh-TW" => "./Fonts/#Pretendard, Microsoft JhengHei UI, Segoe UI",
        _ => "./Fonts/#Pretendard, Segoe UI, Malgun Gothic, Leelawadee UI, Nirmala UI",
    });

    /// <summary>
    /// A heading and the button at its end, in the page's order -- the heading, then the button --
    /// so that the keyboard comes to them so too (the page's .page-head, .preview-head).
    /// </summary>
    public static System.Windows.Controls.Grid HeadRow(System.Windows.UIElement heading, System.Windows.FrameworkElement? end, double gap = 16)
    {
        var g = new System.Windows.Controls.Grid();
        g.ColumnDefinitions.Add(new System.Windows.Controls.ColumnDefinition { Width = new System.Windows.GridLength(1, System.Windows.GridUnitType.Star) });
        g.ColumnDefinitions.Add(new System.Windows.Controls.ColumnDefinition { Width = System.Windows.GridLength.Auto });
        g.Children.Add(heading);
        if (end is not null)
        {
            end.Margin = new System.Windows.Thickness(gap, end.Margin.Top, 0, 0);
            end.VerticalAlignment = System.Windows.VerticalAlignment.Top;
            System.Windows.Controls.Grid.SetColumn(end, 1);
            g.Children.Add(end);
        }
        return g;
    }

    /// <summary>The library's short id of a copy, which the command line shows too; the start of its uid when it has none.</summary>
    public static string ShortId(Copy c) =>
        c.Raw.ValueKind == JsonValueKind.Object && c.Raw.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String && id.GetString() is { Length: > 0 } s
            ? s : c.Uid[..Math.Min(8, c.Uid.Length)];

    /// <summary>The other kinds of copy the same content was found as.</summary>
    public static List<string> Seen(Copy c) =>
        c.Raw.ValueKind == JsonValueKind.Object && c.Raw.TryGetProperty("seen", out var s) && s.ValueKind == JsonValueKind.Array
            ? s.EnumerateArray().Where((x) => x.ValueKind == JsonValueKind.String).Select((x) => x.GetString()!).Where((k) => k != c.Kind).ToList()
            : [];
}
