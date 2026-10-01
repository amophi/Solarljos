using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Solarljos.Core;

namespace Solarljos.Views.Media;

/// <summary>
/// The grid's thumbnails (thumbLoader in src/gui/ui/app.js): loaded only for the tiles in sight
/// and those about to come into it, at most four at a time, and kept small. A picture is decoded
/// at no more than 320 pixels wide, turned as its Exif orientation says, and kept as a small JPEG
/// (a PNG where it is see-through), in memory only, so that a grid of thousands does not hold
/// thousands of bitmaps; it is drawn again from that when its tile comes back into sight. A large
/// JPEG is shown by the small picture a camera or a phone puts inside it, which the engine takes
/// from its first 64 KB; a video by its frame at 0.1 s, through Windows' media player. What
/// cannot be shown -- HEIC without its codec, a camera's RAW -- says "No preview" with its format.
/// Nothing of it is ever written to disk.
/// </summary>
public sealed class Thumbs
{
    const int Px = 320;
    const int AtOnce = 4;
    const long MaxBytes = 48L * 1024 * 1024;
    const long OwnThumbOver = 1024 * 1024;

    readonly Dictionary<string, byte[]> small = new();
    readonly Dictionary<string, WeakReference<BitmapSource>> drawn = new();
    readonly Dictionary<string, string?> none = new();
    readonly LinkedList<string> queue = new();
    readonly HashSet<string> queued = new();
    readonly HashSet<string> loading = new();
    Session? session;
    Func<string, Tile?> tileOf = (_) => null;
    int active;
    int generation;

    /// <summary>The grid whose tiles are shown: which tile shows a copy now, if any.</summary>
    public void Use(Session s, Func<string, Tile?> find)
    {
        session = s;
        tileOf = find;
    }

    /// <summary>Lets go of every thumbnail: for another search, whose copies are others.</summary>
    public void Reset()
    {
        generation++;
        small.Clear();
        drawn.Clear();
        none.Clear();
        queue.Clear();
        queued.Clear();
    }

    /// <summary>Whether any thumbnail is still being made or waits to be: for the pictures of the window.</summary>
    public bool Busy => active > 0 || queue.Any((uid) => tileOf(uid) is not null);

    /// <summary>A tile came into sight: its picture at once when there is one, else it is asked for.</summary>
    public void Want(Tile tile)
    {
        var uid = tile.Copy.Uid;
        if (Show(tile)) return;
        tile.ShowLoading();
        if (queued.Contains(uid) || loading.Contains(uid)) return;
        queue.AddLast(uid);
        queued.Add(uid);
        Pump();
    }

    /// <summary>Shows what is known of a tile's copy already; false when it is still to be made.</summary>
    bool Show(Tile tile)
    {
        var uid = tile.Copy.Uid;
        if (none.TryGetValue(uid, out var ext))
        {
            tile.ShowNone(ext);
            return true;
        }
        if (drawn.TryGetValue(uid, out var weak) && weak.TryGetTarget(out var bmp))
        {
            tile.ShowPicture(bmp);
            return true;
        }
        if (small.TryGetValue(uid, out var bytes))
        {
            try
            {
                var b = Decode(bytes, 1);
                drawn[uid] = new WeakReference<BitmapSource>(b);
                tile.ShowPicture(b);
            }
            catch (Exception e) when (e is NotSupportedException or FileFormatException or IOException or InvalidOperationException or ArgumentException)
            {
                none[uid] = null;
                tile.ShowNone(null);
            }
            return true;
        }
        return false;
    }

    void Pump()
    {
        while (active < AtOnce && queue.First is { } first)
        {
            var uid = first.Value;
            queue.RemoveFirst();
            queued.Remove(uid);
            // Gone out of sight while it waited: asked for again when it comes back.
            if (tileOf(uid) is not { } tile) continue;
            active++;
            loading.Add(uid);
            _ = LoadAsync(uid, tile.Copy, generation);
        }
    }

    async Task LoadAsync(string uid, Copy c, int gen)
    {
        string? ext = c.Ext ?? (c.Name is { } n ? Paths.ExtOf(n) : null);
        byte[]? made = null;
        try
        {
            if (session is null) return;
            var a = await session.Client.AboutAsync(uid);
            var preview = Str(a, "preview");
            ext = Str(a, "ext") ?? ext;
            long? size = a.TryGetProperty("size", out var sz) && sz.ValueKind == JsonValueKind.Number ? (long)sz.GetDouble() : null;
            if (gen != generation) return;
            if (preview == "video") made = await VideoFrameAsync(uid);
            else if (preview == "image")
            {
                // A photo from a camera or a phone carries a small picture of itself: far less to read than the photo.
                if (Str(a, "ext") == ".jpg" && (size is null || size > OwnThumbOver))
                {
                    try
                    {
                        var (own, turn) = await session.Client.GetBytesAsync($"/api/copy/{Uri.EscapeDataString(uid)}/thumb", "X-Solarljos-Orientation");
                        int o = int.TryParse(turn, out var v) ? v : 1;
                        made = await Task.Run(() => Shrink(own, o));
                    }
                    catch (Exception e) when (e is CoreException or NotSupportedException or FileFormatException or IOException or ArgumentException or InvalidOperationException)
                    {
                        made = null; // no small picture of its own, or not a picture after all: the photo itself
                    }
                }
                if (made is null && (size is null || size <= MaxBytes))
                {
                    var bytes = await session.Client.GetBytesAsync($"/api/copy/{Uri.EscapeDataString(uid)}");
                    if (bytes.Length <= MaxBytes) made = await Task.Run(() => Shrink(bytes, 0));
                }
            }
        }
        catch (Exception e) when (e is CoreException or HttpRequestException or TaskCanceledException or NotSupportedException
            or FileFormatException or IOException or ArgumentException or InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            made = null;
        }
        finally
        {
            active--;
            loading.Remove(uid);
            if (gen == generation)
            {
                if (made is not null) small[uid] = made;
                else none[uid] = ext;
                if (tileOf(uid) is { } t && t.Copy.Uid == uid) Show(t);
            }
            Pump();
        }
    }

    static string? Str(JsonElement o, string k) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    // ---- pictures ------------------------------------------------------------------------------

    /// <summary>
    /// A picture's bytes decoded at no more than `max` pixels wide, and turned as an Exif
    /// orientation (1 to 8) says -- `orientation` 0 reads it from the picture itself: 2, 4, 5 and 7
    /// are mirrored, and 5 to 8 a quarter turn, which swaps its sides. Frozen, for any thread.
    /// </summary>
    public static BitmapSource Decode(byte[] bytes, int orientation, int max = 0)
    {
        int o = orientation;
        int w = 0, h = 0;
        if (o == 0 || max > 0)
        {
            using var probe = new MemoryStream(bytes, false);
            var frame = BitmapDecoder.Create(probe, BitmapCreateOptions.DelayCreation | BitmapCreateOptions.IgnoreColorProfile, BitmapCacheOption.None).Frames[0];
            w = frame.PixelWidth;
            h = frame.PixelHeight;
            if (o == 0) o = OrientationOf(frame);
        }
        if (o is < 1 or > 8) o = 1;
        bool turned = o >= 5;
        var bi = new BitmapImage();
        bi.BeginInit();
        bi.CacheOption = BitmapCacheOption.OnLoad;
        bi.StreamSource = new MemoryStream(bytes, false);
        if (max > 0)
        {
            // The side that ends up across.
            if (turned && h > max) bi.DecodePixelHeight = max;
            else if (!turned && w > max) bi.DecodePixelWidth = max;
        }
        bi.EndInit();
        bi.Freeze();
        if (o == 1) return bi;
        Transform turn = o switch
        {
            2 => new ScaleTransform(-1, 1),
            3 => new RotateTransform(180),
            4 => new ScaleTransform(1, -1),
            5 => new TransformGroup { Children = { new RotateTransform(90), new ScaleTransform(-1, 1) } },
            6 => new RotateTransform(90),
            7 => new TransformGroup { Children = { new RotateTransform(90), new ScaleTransform(1, -1) } },
            _ => new RotateTransform(270),
        };
        var t = new TransformedBitmap(bi, turn);
        t.Freeze();
        return t;
    }

    /// <summary>The Exif orientation a picture says it is to be shown in; 1 when it says none.</summary>
    static int OrientationOf(BitmapFrame frame)
    {
        try
        {
            if (frame.Metadata is not BitmapMetadata m) return 1;
            foreach (var q in new[] { "/app1/ifd/{ushort=274}", "/ifd/{ushort=274}" })
            {
                if (m.ContainsQuery(q) && m.GetQuery(q) is { } v) return Convert.ToInt32(v, System.Globalization.CultureInfo.InvariantCulture);
            }
        }
        catch (Exception e) when (e is NotSupportedException or InvalidOperationException or ArgumentException or FormatException or OverflowException
            or System.Runtime.InteropServices.COMException)
        {
        }
        return 1;
    }

    /// <summary>A thumbnail made small and kept as one: decoded at 320 pixels at most, turned, and encoded again.</summary>
    static byte[] Shrink(byte[] bytes, int orientation) => Encode(Decode(bytes, orientation, Px));

    static byte[] Encode(BitmapSource src)
    {
        var f = src.Format;
        bool alpha = f == PixelFormats.Bgra32 || f == PixelFormats.Pbgra32 || f == PixelFormats.Rgba64 || f == PixelFormats.Prgba64
            || f == PixelFormats.Rgba128Float || f == PixelFormats.Prgba128Float || f.Masks.Count == 0 || src.Palette is not null;
        BitmapEncoder enc = alpha ? new PngBitmapEncoder() : new JpegBitmapEncoder { QualityLevel = 85 };
        BitmapSource converted = new FormatConvertedBitmap(src, alpha ? PixelFormats.Pbgra32 : PixelFormats.Bgr24, null, 0);
        converted.Freeze();
        enc.Frames.Add(BitmapFrame.Create(converted));
        using var ms = new MemoryStream();
        enc.Save(ms);
        return ms.ToArray();
    }

    /// <summary>
    /// A video's frame at 0.1 s (or half way through a shorter one), at 320 pixels wide at most,
    /// through Windows' media player, which reads the copy from the engine by its address; null
    /// when it cannot be played here, or takes more than ten seconds.
    /// </summary>
    async Task<byte[]?> VideoFrameAsync(string uid)
    {
        if (session is null) return null;
        var player = new MediaPlayer { IsMuted = true, ScrubbingEnabled = true, Volume = 0 };
        var opened = new TaskCompletionSource<bool>();
        player.MediaOpened += (_, _) => opened.TrySetResult(true);
        player.MediaFailed += (_, _) => opened.TrySetResult(false);
        try
        {
            player.Open(session.Client.CopyUri(uid));
            var first = await Task.WhenAny(opened.Task, Task.Delay(TimeSpan.FromSeconds(10)));
            if (first != opened.Task || !opened.Task.Result) return null;
            int vw = player.NaturalVideoWidth, vh = player.NaturalVideoHeight;
            if (vw <= 0 || vh <= 0) return null;
            player.Pause();
            double length = player.NaturalDuration.HasTimeSpan ? player.NaturalDuration.TimeSpan.TotalSeconds : 1;
            player.Position = TimeSpan.FromSeconds(Math.Min(0.1, length / 2));
            // The player draws the frame it was sent to a moment after.
            await Task.Delay(500);
            double scale = Math.Min(1, (double)Px / vw);
            int w = Math.Max(1, (int)Math.Round(vw * scale)), h = Math.Max(1, (int)Math.Round(vh * scale));
            var dv = new DrawingVisual();
            using (var dc = dv.RenderOpen()) dc.DrawVideo(player, new Rect(0, 0, w, h));
            var rtb = new RenderTargetBitmap(w, h, 96, 96, PixelFormats.Pbgra32);
            rtb.Render(dv);
            rtb.Freeze();
            if (Blank(rtb)) return null;
            var opaque = new FormatConvertedBitmap(rtb, PixelFormats.Bgr24, null, 0);
            opaque.Freeze();
            return Encode(opaque);
        }
        finally
        {
            player.Close();
        }
    }

    /// <summary>Whether nothing was drawn at all: every pixel see-through.</summary>
    static bool Blank(BitmapSource b)
    {
        int stride = b.PixelWidth * 4;
        var px = new byte[stride * b.PixelHeight];
        b.CopyPixels(px, stride, 0);
        for (int i = 3; i < px.Length; i += 4) if (px[i] != 0) return false;
        return true;
    }
}
