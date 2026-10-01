using System.Text;
using System.Text.RegularExpressions;

namespace Solarljos.Core;

/// <summary>
/// Paths as the page reads them (src/gui/ui/app.js, "paths"), Windows' and POSIX ones alike, since
/// a copy may come from another system's disk: an absolute POSIX path separates with "/" alone.
/// </summary>
public static partial class Paths
{
    public static string[] Segments(string p) =>
        (p.StartsWith('/') ? p.Split('/') : p.Split('\\', '/')).Where((s) => s.Length > 0).ToArray();

    public static string BaseName(string p)
    {
        var parts = Segments(p);
        return parts.Length > 0 ? parts[^1] : p;
    }

    /// <summary>The folder a path is in; the root of a drive stays "C:\", since "C:" alone is another folder.</summary>
    public static string DirName(string p)
    {
        int cut = p.StartsWith('/') ? p.LastIndexOf('/') : Math.Max(p.LastIndexOf('/'), p.LastIndexOf('\\'));
        if (cut > 0)
        {
            var up = p[..cut];
            return DriveOnly().IsMatch(up) ? up + "\\" : up;
        }
        return cut == 0 ? p[..1] : "";
    }

    /// <summary>A name's extension, dot included, in lower case; "" for none.</summary>
    public static string ExtOf(string name)
    {
        var b = BaseName(name);
        int dot = b.LastIndexOf('.');
        return dot > 0 ? b[dot..].ToLowerInvariant() : "";
    }

    public static bool IsWindowsPath(string s) => DriveStart().IsMatch(s) || UncStart().IsMatch(s);

    /// <summary>Whether a folder is given whole: a drive letter, a \\server\share, or a POSIX path.</summary>
    public static bool IsAbsolute(string? p)
    {
        var s = (p ?? "").Trim();
        return DriveStart().IsMatch(s) || s.StartsWith(@"\\", StringComparison.Ordinal) || s.StartsWith('/');
    }

    /// <summary>A path as the library compares them: in NFC, and a Windows path in any case, with either slash.</summary>
    public static string Key(string? p)
    {
        var s = (p ?? "").Normalize(NormalizationForm.FormC);
        return IsWindowsPath(s) ? s.Replace('/', '\\').ToLowerInvariant() : s;
    }

    /// <summary>Whether `p` is the folder `dir` or lies below it.</summary>
    public static bool IsInside(string p, string dir)
    {
        var a = Key(p);
        bool windows = IsWindowsPath(dir);
        var b = Key(dir).TrimEnd(windows ? ['\\', '/'] : ['/']);
        return a == b || a.StartsWith(b + (windows ? "\\" : "/"), StringComparison.Ordinal);
    }

    /// <summary>The root a path lies on: "C:\", "\\server\share\" or "/"; null for none. \\.\E: and \\?\E: are "E:\".</summary>
    public static string? RootOf(string? p)
    {
        var s = (p ?? "").Trim();
        var m = DriveOrDevice().Match(s);
        if (m.Success) return char.ToUpperInvariant(m.Groups[1].Value[0]) + @":\";
        m = UncShare().Match(s);
        if (m.Success) return $@"\\{m.Groups[1].Value}\{m.Groups[2].Value}\";
        return s.StartsWith('/') ? "/" : null;
    }

    public static bool SameRoot(string? a, string? b) =>
        !string.IsNullOrEmpty(a) && !string.IsNullOrEmpty(b) && string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    /// <summary>A whole disk or a device, whose drive letter cannot be told: \\.\PhysicalDrive1, /dev/sdb.</summary>
    public static bool IsDevice(string? p)
    {
        var s = (p ?? "").Trim();
        if (DeviceDrive().IsMatch(s)) return false;
        return DevicePrefix().IsMatch(s) || s.StartsWith("/dev/", StringComparison.Ordinal);
    }

    public static string Join(string dir, params string[] names)
    {
        char sep = dir.StartsWith('/') ? '/' : '\\';
        var at = dir;
        foreach (var n in names) at = at.EndsWith('/') || at.EndsWith('\\') ? at + n : at + sep + n;
        return at;
    }

    /// <summary>The cloud service a folder looks synced by, from the folder names they make; null when none.</summary>
    public static string? SyncedBy(string? p)
    {
        var m = Synced().Match(p ?? "");
        return m.Success ? m.Groups[2].Value : null;
    }

    /// <summary>A plan entry's path inside its folder, as parts: the engine sends "a/b.txt".</summary>
    public static string[] RelParts(string rel) => rel.Split('/', StringSplitOptions.RemoveEmptyEntries);

    /// <summary>A path typed with quotes around it, as Explorer's "Copy as path" gives one, without them.</summary>
    public static string Unquote(string s)
    {
        var t = s.Trim();
        return t.Length >= 2 && t[0] == '"' && t[^1] == '"' ? t[1..^1].Trim() : t;
    }

    [GeneratedRegex(@"^[A-Za-z]:$")] private static partial Regex DriveOnly();
    [GeneratedRegex(@"^[A-Za-z]:([\\/]|$)")] private static partial Regex DriveStart();
    [GeneratedRegex(@"^[\\/]{2}[^\\/]")] private static partial Regex UncStart();
    [GeneratedRegex(@"^(?:[\\/]{2}[.?][\\/])?([A-Za-z]):")] private static partial Regex DriveOrDevice();
    [GeneratedRegex(@"^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)")] private static partial Regex UncShare();
    [GeneratedRegex(@"^[\\/]{2}[.?][\\/][A-Za-z]:[\\/]?$")] private static partial Regex DeviceDrive();
    [GeneratedRegex(@"^[\\/]{2}[.?][\\/]")] private static partial Regex DevicePrefix();
    [GeneratedRegex(@"(^|[\\/])(OneDrive|iCloudDrive|iCloud Drive|Dropbox|Google Drive|SynologyDrive)( - [^\\/]+)?([\\/]|$)", RegexOptions.IgnoreCase)]
    private static partial Regex Synced();
}
