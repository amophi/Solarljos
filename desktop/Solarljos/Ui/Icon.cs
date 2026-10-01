using System.Reflection;
using System.Text.Json;
using System.Windows;
using System.Windows.Documents;
using System.Windows.Media;

namespace Solarljos.Ui;

/// <summary>
/// One of the page's icons (Assets/icons.json, from src/gui/ui/app.js): SVG paths on a 24 by 24
/// box, stroked in the colour of the text around it, as the page's currentColor does, 1.7 wide
/// with round ends. Never seen by assistive technology: what it stands for is said in words
/// beside it, or by the control it is in.
/// </summary>
public sealed class Icon : FrameworkElement
{
    static readonly Dictionary<string, Geometry[]> Paths = Load();

    static Dictionary<string, Geometry[]> Load()
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("Assets.icons.json")!;
        var table = JsonSerializer.Deserialize<Dictionary<string, string[]>>(s)!;
        return table.ToDictionary((kv) => kv.Key, (kv) => kv.Value.Select((d) =>
        {
            var g = Geometry.Parse(d);
            g.Freeze();
            return g;
        }).ToArray());
    }

    /// <summary>Every icon's name: for the tests, which parse them all.</summary>
    public static IReadOnlyCollection<string> Names => Paths.Keys;

    public static readonly DependencyProperty GlyphProperty = DependencyProperty.Register(
        nameof(Glyph), typeof(string), typeof(Icon), new FrameworkPropertyMetadata("", FrameworkPropertyMetadataOptions.AffectsRender));

    public static readonly DependencyProperty ForegroundProperty = TextElement.ForegroundProperty.AddOwner(
        typeof(Icon), new FrameworkPropertyMetadata(Brushes.Black, FrameworkPropertyMetadataOptions.Inherits | FrameworkPropertyMetadataOptions.AffectsRender));

    public static readonly DependencyProperty ThicknessProperty = DependencyProperty.Register(
        nameof(Thickness), typeof(double), typeof(Icon), new FrameworkPropertyMetadata(1.7, FrameworkPropertyMetadataOptions.AffectsRender));

    /// <summary>Filled rather than stroked: the sun of the mark.</summary>
    public static readonly DependencyProperty FilledProperty = DependencyProperty.Register(
        nameof(Filled), typeof(bool), typeof(Icon), new FrameworkPropertyMetadata(false, FrameworkPropertyMetadataOptions.AffectsRender));

    public string Glyph { get => (string)GetValue(GlyphProperty); set => SetValue(GlyphProperty, value); }
    public Brush Foreground { get => (Brush)GetValue(ForegroundProperty); set => SetValue(ForegroundProperty, value); }
    public double Thickness { get => (double)GetValue(ThicknessProperty); set => SetValue(ThicknessProperty, value); }
    public bool Filled { get => (bool)GetValue(FilledProperty); set => SetValue(FilledProperty, value); }

    public Icon()
    {
        Width = 20;
        Height = 20;
        Focusable = false;
        SnapsToDevicePixels = false;
    }

    protected override System.Windows.Automation.Peers.AutomationPeer? OnCreateAutomationPeer() => null;

    protected override void OnRender(DrawingContext dc)
    {
        if (!Paths.TryGetValue(Glyph ?? "", out var geometries)) return;
        double scale = Math.Min(ActualWidth, ActualHeight) / 24;
        if (scale <= 0) return;
        // RTL mirroring of the arrows that point on through the page is the layout's: FlowDirection.
        dc.PushTransform(new ScaleTransform(scale, scale));
        var pen = Filled ? null : new Pen(Foreground, Thickness) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round, LineJoin = PenLineJoin.Round };
        foreach (var g in geometries) dc.DrawGeometry(Filled ? Foreground : null, pen, g);
        dc.Pop();
    }
}
