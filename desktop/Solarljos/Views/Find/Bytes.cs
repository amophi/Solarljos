using System.Text;

namespace Solarljos.Views.Find;

/// <summary>
/// A copy's bytes as the preview reads them (src/gui/ui/app.js, "bytes"): rows of a hex view,
/// whether they are all zero, what they start with, and text in the encoding chosen.
/// </summary>
public static class Bytes
{
    /// <summary>The encodings the text can be read in, by the page's names, with the keys of their words.</summary>
    public static readonly (string Value, string Key)[] Encodings =
    [
        ("auto", "preview.encoding.auto"), ("utf-8", "preview.encoding.utf8"), ("utf-16le", "preview.encoding.utf16le"),
        ("utf-16be", "preview.encoding.utf16be"), ("euc-kr", "preview.encoding.korean"), ("windows-1252", "preview.encoding.western"),
    ];

    static Bytes()
    {
        // Korean and the Western code page are not in .NET by itself: Windows' own tables, in the framework.
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    }

    public sealed record HexRow(long Offset, string Hex, string Ascii);

    /// <summary>Bytes as the rows of a hex view: offset, sixteen bytes in two runs of eight, and those as ASCII.</summary>
    public static List<HexRow> HexRows(byte[] bytes, long offset)
    {
        var rows = new List<HexRow>();
        for (int i = 0; i < bytes.Length; i += 16)
        {
            int n = Math.Min(16, bytes.Length - i);
            var hex = new StringBuilder(48);
            var ascii = new StringBuilder(16);
            for (int j = 0; j < n; j++)
            {
                if (j > 0) hex.Append(j == 8 ? "  " : " ");
                byte x = bytes[i + j];
                hex.Append(x.ToString("x2"));
                ascii.Append(x >= 0x20 && x < 0x7f ? (char)x : '.');
            }
            rows.Add(new HexRow(offset + i, hex.ToString(), ascii.ToString()));
        }
        return rows;
    }

    /// <summary>Whether bytes are there and every one is zero: what a drive gives back for a file it erased.</summary>
    public static bool IsAllZero(byte[]? bytes) => bytes is { Length: > 0 } && Array.TrueForAll(bytes, (x) => x == 0);

    /// <summary>The first bytes as hex, "FF D8 FF E0", for saying what a file starts with.</summary>
    public static string MagicOf(byte[] bytes, int n = 8) => string.Join(" ", bytes.Take(n).Select((x) => x.ToString("X2")));

    public sealed record Decoded(string Text, string Encoding, string? Bom);

    static Encoding? EncodingOf(string label, bool strict) => label switch
    {
        "utf-8" => new UTF8Encoding(false, strict),
        "utf-16le" => new UnicodeEncoding(false, false, strict),
        "utf-16be" => new UnicodeEncoding(true, false, strict),
        // What a browser reads EUC-KR as: CP949, Windows' Korean, which holds every Hangul syllable.
        "euc-kr" => System.Text.Encoding.GetEncoding(949, EncoderFallback.ReplacementFallback, strict ? DecoderFallback.ExceptionFallback : DecoderFallback.ReplacementFallback),
        "windows-1252" => System.Text.Encoding.GetEncoding(1252, EncoderFallback.ReplacementFallback, strict ? DecoderFallback.ExceptionFallback : DecoderFallback.ReplacementFallback),
        _ => null,
    };

    /// <summary>
    /// Text from bytes (decodeText in app.js). Automatic reads a byte order mark first; then UTF-8
    /// if every byte fits it; then Korean (CP949), the other encoding a file on a Korean PC is in;
    /// the Western code page otherwise. `cut`: the bytes end where the copy does not, so a
    /// character cut in two at the end is left out rather than taken for a wrong encoding.
    /// </summary>
    public static Decoded DecodeText(byte[] bytes, string encoding, bool cut)
    {
        string? bom = null;
        if (bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf) bom = "utf-8";
        else if (bytes.Length >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe) bom = "utf-16le";
        else if (bytes.Length >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff) bom = "utf-16be";

        string? Decode(string label, bool strict)
        {
            var enc = EncodingOf(label, strict);
            if (enc is null) return null;
            int skip = label == bom ? (bom == "utf-8" ? 3 : 2) : 0;
            try
            {
                var decoder = enc.GetDecoder();
                int count = bytes.Length - skip;
                var chars = new char[enc.GetMaxCharCount(Math.Max(0, count))];
                // Not flushed when cut: what is left of a character at the end is held back, not taken for an error.
                int n = decoder.GetChars(bytes, skip, Math.Max(0, count), chars, 0, !cut);
                return new string(chars, 0, n);
            }
            catch (DecoderFallbackException)
            {
                return null;
            }
        }

        if (encoding is { Length: > 0 } && encoding != "auto")
            return new Decoded(Decode(encoding, false) ?? "", encoding, bom == encoding ? bom : null);
        if (bom is not null) return new Decoded(Decode(bom, false) ?? "", bom, bom);
        if (Decode("utf-8", true) is { } utf8) return new Decoded(utf8, "utf-8", null);
        if (Decode("euc-kr", true) is { } korean) return new Decoded(korean, "euc-kr", null);
        return new Decoded(Decode("windows-1252", false) ?? "", "windows-1252", null);
    }
}
