using System.Windows;

namespace Solarljos.Ui;

/// <summary>What the styles read off a control beyond WPF's own properties: its corners, and its icon.</summary>
public static class Look
{
    public static readonly DependencyProperty RadiusProperty = DependencyProperty.RegisterAttached(
        "Radius", typeof(CornerRadius), typeof(Look), new FrameworkPropertyMetadata(new CornerRadius(10), FrameworkPropertyMetadataOptions.Inherits));

    public static CornerRadius GetRadius(DependencyObject o) => (CornerRadius)o.GetValue(RadiusProperty);
    public static void SetRadius(DependencyObject o, CornerRadius v) => o.SetValue(RadiusProperty, v);

    /// <summary>The name of an icon a button shows before its words (Ui.Icon).</summary>
    public static readonly DependencyProperty GlyphProperty = DependencyProperty.RegisterAttached(
        "Glyph", typeof(string), typeof(Look), new FrameworkPropertyMetadata(null));

    public static string? GetGlyph(DependencyObject o) => (string?)o.GetValue(GlyphProperty);
    public static void SetGlyph(DependencyObject o, string? v) => o.SetValue(GlyphProperty, v);

    /// <summary>A rail item that starts a group of its own: a line above it, and room.</summary>
    public static readonly DependencyProperty GroupStartProperty = DependencyProperty.RegisterAttached(
        "GroupStart", typeof(bool), typeof(Look), new FrameworkPropertyMetadata(false));

    public static bool GetGroupStart(DependencyObject o) => (bool)o.GetValue(GroupStartProperty);
    public static void SetGroupStart(DependencyObject o, bool v) => o.SetValue(GroupStartProperty, v);
}
