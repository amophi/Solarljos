using System.ComponentModel;
using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;

namespace Solarljos.Text;

/// <summary>
/// The words of the program, by key, in the language chosen -- the page's tables
/// (src/gui/ui/strings.js in English, src/gui/ui/lang/&lt;code&gt;.json for the rest), embedded,
/// and read as the page reads them (tr() in src/gui/ui/app.js): {name} placeholders, a number
/// written as the language writes numbers, a set of plural forms chosen by the count, English for
/// a key a language leaves out, and the key itself for one no table has. In Arabic what is put in
/// keeps its own direction (Isolate), so that a path is not turned round by the sentence.
///
/// XAML binds to it through the indexer ({u:T key}), which it says has changed whenever the
/// language does; code asks Get(key, ("name", value), ...).
/// </summary>
public sealed partial class Tr : INotifyPropertyChanged
{
    public static Tr Instance { get; } = new();

    public event PropertyChangedEventHandler? PropertyChanged;
    /// <summary>After the language has changed, for what is not bound: a view made in code.</summary>
    public event Action? Changed;

    readonly Dictionary<string, JsonElement> english;
    Dictionary<string, JsonElement> table;

    public string Code { get; private set; } = "en";
    public CultureInfo Culture { get; private set; } = CultureInfo.GetCultureInfo("en-GB");
    public FlowDirection Direction { get; private set; } = FlowDirection.LeftToRight;
    public string Locale { get; private set; } = "en-GB";

    /// <summary>The languages there is a table for, English first, each by its own name.</summary>
    public IReadOnlyList<Language> Languages { get; }

    public sealed record Language(string Code, string Name)
    {
        // What a list of them shows.
        public override string ToString() => Name;
    }

    Tr()
    {
        english = ReadTable("Assets.en.json") ?? throw new InvalidOperationException("Assets/en.json is not in the program");
        table = english;
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("Assets.languages.json")!;
        var all = JsonSerializer.Deserialize<List<Language>>(s, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        var embedded = Assembly.GetExecutingAssembly().GetManifestResourceNames().ToHashSet();
        Languages = all.Where((l) => l.Code == "en" || embedded.Contains($"Lang.{l.Code}.json")).ToList();
    }

    static Dictionary<string, JsonElement>? ReadTable(string resource)
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource);
        if (s is null) return null;
        using var doc = JsonDocument.Parse(s);
        return doc.RootElement.EnumerateObject().ToDictionary((p) => p.Name, (p) => p.Value.Clone());
    }

    /// <summary>The language of these codes that there is a table for, as the page picks one: the first that matches.</summary>
    public string Pick(IEnumerable<string> wanted)
    {
        foreach (var w in wanted)
        {
            if (string.IsNullOrEmpty(w)) continue;
            var exact = Languages.FirstOrDefault((l) => string.Equals(l.Code, w, StringComparison.OrdinalIgnoreCase));
            if (exact is not null) return exact.Code;
            var lang = w.Split('-')[0];
            // zh-Hant, zh-TW and zh-HK read the traditional letters; any other Chinese the simplified.
            if (lang.Equals("zh", StringComparison.OrdinalIgnoreCase))
            {
                bool traditional = Regex.IsMatch(w, "Hant|TW|HK|MO", RegexOptions.IgnoreCase);
                return traditional ? "zh-TW" : "zh-CN";
            }
            if (lang.Equals("pt", StringComparison.OrdinalIgnoreCase) && Languages.Any((l) => l.Code == "pt-BR")) return "pt-BR";
            var near = Languages.FirstOrDefault((l) => l.Code.Split('-')[0].Equals(lang, StringComparison.OrdinalIgnoreCase));
            if (near is not null) return near.Code;
        }
        return "en";
    }

    /// <summary>Speaks this language from now on; English for one there is no table for.</summary>
    public void Use(string code)
    {
        var t = code == "en" ? english : ReadTable($"Lang.{code}.json");
        if (t is null)
        {
            code = "en";
            t = english;
        }
        table = t;
        Code = code;
        Locale = Meta("meta.locale") ?? code;
        Culture = CultureOf(Locale, code);
        Direction = Meta("meta.dir") == "rtl" ? FlowDirection.RightToLeft : FlowDirection.LeftToRight;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs("Item[]"));
        Changed?.Invoke();
    }

    string? Meta(string key) => table.TryGetValue(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    static CultureInfo CultureOf(string locale, string code)
    {
        // "ar-u-nu-latn" and the like: .NET knows the language and region, not the extensions.
        var plain = Regex.Replace(locale, "-u-.*$", "");
        foreach (var name in new[] { plain, code, "en-GB" })
        {
            try
            {
                var c = CultureInfo.GetCultureInfo(name);
                if (!Regex.IsMatch(locale, "-u-(.*-)?nu-latn")) return c;
                // Latin digits, which .NET writes anyway, with the separators that go with them:
                // "1,234,567.5", as Intl writes it, not "1٬234٬567٫5".
                var latin = (CultureInfo)c.Clone();
                latin.NumberFormat.NumberGroupSeparator = ",";
                latin.NumberFormat.NumberDecimalSeparator = ".";
                return CultureInfo.ReadOnly(latin);
            }
            catch (CultureNotFoundException)
            {
            }
        }
        return CultureInfo.InvariantCulture;
    }

    public string this[string key] => Get(key);

    /// <summary>Whether any table has the key.</summary>
    public bool Has(string key) => table.ContainsKey(key) || english.ContainsKey(key);

    /// <summary>A string by key, with its placeholders filled in (see the class).</summary>
    public string Get(string key, params (string Name, object? Value)[] args)
    {
        if (!table.TryGetValue(key, out var v) && !english.TryGetValue(key, out v)) return key;
        if (!table.ContainsKey(key)) return Fill(Choose(v, args, "en"), args);
        var text = Choose(v, args, Locale);
        return Fill(Code == "ko" ? KeepAll(text) : text, args);
    }

    /// <summary>
    /// Korean puts spaces between its words, and a line should break there, not between the
    /// syllables of one, as the page's word-break: keep-all has it. WPF breaks between any two
    /// syllables, so the words of the table are held together with WORD JOINER (U+2060), which
    /// shows nothing. Only the table's words: a name or a path put in is left as it is, so that
    /// what is copied from the window is the path itself.
    /// </summary>
    internal static string KeepAll(string text)
    {
        var b = new System.Text.StringBuilder(text.Length + text.Length / 2);
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (i > 0)
            {
                char p = text[i - 1];
                bool joins = !char.IsWhiteSpace(p) && !char.IsWhiteSpace(c) && p != '{' && c != '{' && p != '}' && c != '}'
                    && (IsHangul(p) || IsHangul(c));
                if (joins) b.Append('\u2060');
            }
            b.Append(c);
        }
        return b.ToString();
    }

    /// <summary>
    /// A string by key without what KeepAll puts in, for words that become part of a path, such as
    /// the folder a restore suggests: a name on the disk must hold only what it shows.
    /// </summary>
    public string Plain(string key, params (string Name, object? Value)[] args) => Get(key, args).Replace(((char)0x2060).ToString(), "");

    static bool IsHangul(char c) => c is >= '\uAC00' and <= '\uD7A3' or >= '\u1100' and <= '\u11FF' or >= '\u3130' and <= '\u318F';

    static string Choose(JsonElement v, (string Name, object? Value)[] args, string locale)
    {
        if (v.ValueKind == JsonValueKind.String) return v.GetString() ?? "";
        if (v.ValueKind != JsonValueKind.Object) return v.ToString();
        // Without a count no form is right: "other", as the page does.
        var count = args.FirstOrDefault((a) => a.Name == "count").Value;
        string form = "other";
        if (count is not null && TryWhole(count, out long n)) form = Plural.Select(locale, n);
        if (v.TryGetProperty(form, out var f) && f.ValueKind == JsonValueKind.String) return f.GetString() ?? "";
        return v.TryGetProperty("other", out var o) ? o.GetString() ?? "" : "";
    }

    static bool TryWhole(object x, out long n)
    {
        switch (x)
        {
            case int i: n = i; return true;
            case long l: n = l; return true;
            case double d when Math.Abs(d % 1) < double.Epsilon: n = (long)d; return true;
            default: n = 0; return false;
        }
    }

    string Fill(string text, (string Name, object? Value)[] args)
    {
        if (args.Length == 0 || text.IndexOf('{') < 0) return text;
        bool isolate = Direction == FlowDirection.RightToLeft;
        return Placeholder().Replace(text, (m) =>
        {
            var name = m.Groups[1].Value;
            foreach (var (n, value) in args)
            {
                if (n != name || value is null) continue;
                return value switch
                {
                    int or long => Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString("#,##0", Culture),
                    double d => d.ToString("#,##0.###", Culture),
                    _ => isolate ? Isolate(value.ToString() ?? "") : value.ToString() ?? "",
                };
            }
            return m.Value;
        });
    }

    /// <summary>
    /// A name or a path put into a right-to-left sentence, held in its own direction, as the page
    /// isolates it (U+2068 ... U+2069). WPF's text knows neither the isolates nor the embeddings
    /// (U+202A ... U+202C), which leave "D:\" or "20240501_123045.jpg" turned round, so a mark
    /// of the value's own direction goes on each side of it: what is between two left-to-right
    /// marks stays left to right, the backslash at its end included.
    /// </summary>
    public static string Isolate(string value)
    {
        var mark = DirectionOf(value) == FlowDirection.RightToLeft ? "\u200F" : "\u200E";
        return mark + value + mark;
    }

    /// <summary>
    /// The direction a name reads in, from its first letter that has one (the page's bdi and
    /// dir=auto): one in Arabic or Hebrew right to left, any other, or one with no letter, left to right.
    /// </summary>
    public static FlowDirection DirectionOf(string text)
    {
        foreach (var ch in text)
        {
            if (ch is >= '\u0590' and <= '\u08FF' or >= '\uFB1D' and <= '\uFDFF' or >= '\uFE70' and <= '\uFEFC') return FlowDirection.RightToLeft;
            if (char.IsLetter(ch)) return FlowDirection.LeftToRight;
        }
        return FlowDirection.LeftToRight;
    }

    /// <summary>A number as the language writes it.</summary>
    public string Number(long n) => n.ToString("#,##0", Culture);

    [GeneratedRegex(@"\{(\w+)\}")]
    private static partial Regex Placeholder();
}
