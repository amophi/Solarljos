using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Solarljos.Dev;

/// <summary>
/// A picture of the window, for working on the program: when SOLARLJOS_SHOT is set --
/// "out=C:\...\home.png;route=find;w=1280;h=800;theme=dark;lang=ko;rail=compact" -- the window
/// opens off the screen and out of the taskbar, goes to that part, waits for it to settle, writes
/// what its client area shows as a PNG, and the program ends. Used with an engine that searches
/// made-up places (SOLARLJOS_CORE), never this PC's own files.
/// </summary>
public sealed class Shot
{
    public string Out { get; private init; } = "";
    public string Route { get; private init; } = "";
    public int Width { get; private init; } = 1280;
    public int Height { get; private init; } = 800;
    public bool Dark { get; private init; } = true;
    public string? Lang { get; private init; }
    public string? Rail { get; private init; }
    /// <summary>What the view is to do before the picture, by name: a view's own (IShootable).</summary>
    public string? Act { get; private init; }

    public static Shot? FromEnvironment()
    {
        var spec = Environment.GetEnvironmentVariable("SOLARLJOS_SHOT");
        if (string.IsNullOrWhiteSpace(spec)) return null;
        var kv = spec.Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Select((p) => p.Split('=', 2)).Where((p) => p.Length == 2)
            .ToDictionary((p) => p[0].Trim(), (p) => p[1].Trim());
        return new Shot
        {
            Out = kv.GetValueOrDefault("out", "shot.png"),
            Route = kv.GetValueOrDefault("route", ""),
            Width = int.TryParse(kv.GetValueOrDefault("w"), out var w) ? w : 1280,
            Height = int.TryParse(kv.GetValueOrDefault("h"), out var h) ? h : 800,
            Dark = kv.GetValueOrDefault("theme", "dark") != "light",
            Lang = kv.GetValueOrDefault("lang"),
            Rail = kv.GetValueOrDefault("rail"),
            Act = kv.GetValueOrDefault("act"),
        };
    }

    /// <summary>Puts the window where no one sees it, at the size asked for.</summary>
    public void Place(Window w)
    {
        w.WindowStartupLocation = WindowStartupLocation.Manual;
        w.Left = -32000;
        w.Top = -32000;
        w.Width = Width;
        w.Height = Height;
        w.ShowInTaskbar = false;
        w.ShowActivated = false;
    }

    /// <summary>Writes what the window's client area shows, at 96 DPI.</summary>
    public async Task TakeAsync(Window w)
    {
        // Two rounds of layout and render, and the time a fade or a picture takes to come in.
        await Task.Delay(900);
        await w.Dispatcher.InvokeAsync(() => { }, System.Windows.Threading.DispatcherPriority.ApplicationIdle);
        var root = (FrameworkElement)w.Content;
        int width = (int)Math.Ceiling(root.ActualWidth), height = (int)Math.Ceiling(root.ActualHeight);
        var bmp = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        var area = new Rect(0, 0, width, height);
        // The window's own area, not the bounds of what is drawn: a shadow reaches past them.
        var brush = new VisualBrush(root)
        {
            Stretch = Stretch.None, AlignmentX = AlignmentX.Left, AlignmentY = AlignmentY.Top,
            ViewboxUnits = BrushMappingMode.Absolute, Viewbox = area, ViewportUnits = BrushMappingMode.Absolute, Viewport = area,
        };
        var back = new DrawingVisual();
        using (var dc = back.RenderOpen())
        {
            dc.DrawRectangle(w.Background, null, area);
            // Right to left, the window mirrors what it holds; the brush sees it unmirrored.
            if (w.FlowDirection == FlowDirection.RightToLeft) dc.PushTransform(new MatrixTransform(-1, 0, 0, 1, width, 0));
            dc.DrawRectangle(brush, null, area);
        }
        bmp.Render(back);
        var png = new PngBitmapEncoder();
        png.Frames.Add(BitmapFrame.Create(bmp));
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(Out))!);
        await using var f = File.Create(Out);
        png.Save(f);
    }
}
