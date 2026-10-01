using System.Text.Json;
using System.Text.RegularExpressions;

namespace Solarljos.Core;

/// <summary>
/// A copy as the engine sends one (uiCopy in src/gui/server.js): plain fields, never its bytes.
/// What the page works out of one (src/gui/ui/app.js, "what a copy is") is here too: its tier,
/// how it ranks against other copies of its file, what its date means.
/// </summary>
public sealed partial class Copy
{
    public static readonly string[] Tiers = ["exact", "inexact", "draft", "unverified", "derived"];

    public string Uid { get; init; } = "";
    public string Kind { get; init; } = "";
    public string? KindLabel { get; init; }
    public string Source { get; init; } = "";
    public string? Path { get; init; }
    public string? RawName { get; init; }
    public string? Ext { get; init; }
    /// <summary>Its time in ms since 1970, UTC; null when it carries none.</summary>
    public double? Time { get; init; }
    public long? Size { get; init; }
    /// <summary>"deleted", "exists", "no content" or "".</summary>
    public string State { get; init; } = "";
    public int Copies { get; init; } = 1;
    public bool IsDir { get; init; }
    public bool Gone { get; init; }
    public bool Draft { get; init; }
    public bool Inexact { get; init; }
    public bool Unverified { get; init; }
    public bool Derived { get; init; }
    public JsonElement TierValue { get; init; }
    public string? MediaType { get; init; }
    public int? Width { get; init; }
    public int? Height { get; init; }
    public string? Note { get; init; }
    public string? Origin { get; init; }
    /// <summary>The copy as it came, for what is sent back: a restore names it by Uid.</summary>
    public JsonElement Raw { get; init; }

    public static Copy From(JsonElement c)
    {
        static string? S(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        static bool B(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.True;
        static double? D(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;
        double? time = D(c, "time");
        if (time is null && S(c, "time") is { } iso && DateTimeOffset.TryParse(iso, out var at)) time = at.ToUnixTimeMilliseconds();
        return new Copy
        {
            Uid = S(c, "uid") ?? S(c, "id") ?? "",
            Kind = S(c, "kind") ?? "",
            KindLabel = S(c, "kindLabel"),
            Source = S(c, "source") ?? "",
            Path = S(c, "path"),
            RawName = S(c, "name"),
            Ext = S(c, "ext"),
            Time = time,
            Size = D(c, "size") is { } size ? (long)size : null,
            State = S(c, "state") ?? "",
            Copies = D(c, "copies") is { } n ? (int)n : 1,
            IsDir = B(c, "isDir"),
            Gone = B(c, "gone"),
            Draft = B(c, "draft"),
            Inexact = B(c, "inexact"),
            Unverified = B(c, "unverified") || B(c, "pieced") || B(c, "partial"),
            Derived = B(c, "derived") || B(c, "smaller"),
            TierValue = c.TryGetProperty("tier", out var tier) ? tier.Clone() : default,
            MediaType = S(c, "mediaType") ?? S(c, "media"),
            Width = D(c, "width") is { } w ? (int)w : null,
            Height = D(c, "height") is { } h ? (int)h : null,
            Note = S(c, "note"),
            Origin = S(c, "origin"),
            Raw = c.Clone(),
        };
    }

    /// <summary>Its name: the one it came with, or the last part of its path.</summary>
    public string? Name => RawName ?? (Path is null ? null : Paths.BaseName(Path));

    /// <summary>The folder it was in; null when that is not known.</summary>
    public string? Folder => Path is null ? null : Paths.DirName(Path) is { Length: > 0 } d ? d : null;

    public DateTimeOffset? When => Time is { } ms && double.IsFinite(ms) ? DateTimeOffset.FromUnixTimeMilliseconds((long)ms) : null;

    /// <summary>For comparing: a copy with no time is older than any with one.</summary>
    public double TimeOr => Time is { } ms && double.IsFinite(ms) ? ms : double.NegativeInfinity;

    /// <summary>"image", "video", ... as src/types.js names them.</summary>
    public string? Media => MediaType == "photo" ? "image" : MediaType;

    /// <summary>
    /// Its quality: one of Tiers, or "folder" or "gone". The worst of what the engine's tier says --
    /// a number, or a name -- and what its flags say.
    /// </summary>
    public string Tier
    {
        get
        {
            if (Gone || State == "no content") return "gone";
            if (IsDir) return "folder";
            string? named = TierValue.ValueKind == JsonValueKind.String ? Alias(TierValue.GetString()) : null;
            if (named is "folder" or "gone") return named;
            int t = TierValue.ValueKind == JsonValueKind.Number && TierValue.GetInt32() is var n && n >= 0 && n < Tiers.Length ? n
                : named is not null ? Array.IndexOf(Tiers, named) : 0;
            if (t < 0) t = 0;
            if (Derived) t = Math.Max(t, 4);
            if (Unverified) t = Math.Max(t, 3);
            if (Draft) t = Math.Max(t, 2);
            if (Inexact) t = Math.Max(t, 1);
            return Tiers[t];
        }
    }

    static string? Alias(string? name) => name switch
    {
        "exact" => "exact",
        "inexact" or "near" => "inexact",
        "draft" => "draft",
        "unverified" or "pieced" or "partial" => "unverified",
        "derived" or "smaller" => "derived",
        "folder" => "folder",
        "gone" => "gone",
        _ => null,
    };

    /// <summary>How it ranks when copies of one file compete: its tier, a folder with the exact, nothing left last.</summary>
    public int Rank => Tier switch { "gone" => 9, "folder" => 0, var t => Array.IndexOf(Tiers, t) };

    /// <summary>
    /// Whether this copy is to be preferred over `b`: src/quality.js's better(), without its table of
    /// fidelities, which only decides between copies from the same moment.
    /// </summary>
    public bool Better(Copy b) => Rank != b.Rank ? Rank < b.Rank : TimeOr > b.TimeOr;

    /// <summary>
    /// What its date means, by the kind of copy: when it was deleted, saved, backed up, written,
    /// read or committed, or when the file last changed; "unknown" says only the date.
    /// </summary>
    public string TimeMeaning
    {
        get
        {
            var k = Kind;
            if (DeletedKinds().IsMatch(k)) return "deleted";
            if (SavedKinds().IsMatch(k)) return "saved";
            if (k.StartsWith("claude backup", StringComparison.Ordinal)) return "backedUp";
            if (WrittenKinds().IsMatch(k)) return "written";
            if (k is "claude read" or "antigravity read") return "read";
            if (k is "git commit" or "git, deleted in a commit") return "committed";
            if (ModifiedKinds().IsMatch(k)) return "modified";
            return "unknown";
        }
    }

    /// <summary>Read back from where a card's file system says it lay: inexact there means a later file may be over it.</summary>
    public bool FromDisk => FromDiskKinds().IsMatch(Kind);

    [GeneratedRegex(@"^(recycle bin|trash)\b")] private static partial Regex DeletedKinds();
    [GeneratedRegex(@"^(local history|notepad, as last saved|hancom)")] private static partial Regex SavedKinds();
    [GeneratedRegex(@"^(claude write|antigravity write)")] private static partial Regex WrittenKinds();
    [GeneratedRegex(@"^(git index|shadow copy|jetbrains|eclipse|claude, |unsaved editor buffer|notepad, (edits|untitled)|(ex)?fat undelete$)")]
    private static partial Regex ModifiedKinds();
    [GeneratedRegex(@"^(ex)?fat undelete$")] private static partial Regex FromDiskKinds();
}
