using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using Solarljos.Text;
using Solarljos.Ui;

namespace Solarljos.Views.Sources;

/// <summary>
/// The small pieces of what is searched and of help that Ui.Build does not have: a small button
/// (.btn.small), a note with its icon (.note-line), a list with bullets, a paragraph.
/// </summary>
public static class Bits
{
    /// <summary>A button made small, as the page's .btn.small: 32 pixels high, 14-pixel words.</summary>
    public static Button Small(Button b)
    {
        b.MinHeight = 32;
        b.MinWidth = 32;
        b.Padding = new Thickness(12, 4, 12, 4);
        b.FontSize = 14;
        Look.SetRadius(b, new CornerRadius(8));
        return b;
    }

    /// <summary>A line of what to know about a place, its icon before it, in the second text colour.</summary>
    public static DockPanel NoteLine(string glyph, string text)
    {
        var icon = new Icon { Glyph = glyph, Width = 18, Height = 18, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 2, 8, 0) };
        icon.SetResourceReference(Icon.ForegroundProperty, "Text2");
        var words = Build.Text(text, "Muted");
        words.FontSize = 14;
        words.LineHeight = 21;
        Upright(icon);
        var line = new DockPanel { Margin = new Thickness(0, 8, 0, 0) };
        DockPanel.SetDock(icon, Dock.Left);
        line.Children.Add(icon);
        line.Children.Add(words);
        return line;
    }

    /// <summary>
    /// Right to left, the window mirrors what it draws; the page turns only the arrow that points
    /// on (the chevron), and draws every other icon -- a check mark, a pencil -- as it is.
    /// </summary>
    public static T Upright<T>(T root) where T : DependencyObject
    {
        if (root is Icon icon && icon.Glyph != "chevron") icon.FlowDirection = FlowDirection.LeftToRight;
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) Upright(child);
        return root;
    }

    /// <summary>A paragraph, 8 pixels from the one before it as the page's p.</summary>
    public static TextBlock Para(string text, bool first = false) => Build.Text(text).Margin(0, first ? 0 : 8, 0, 0);

    /// <summary>
    /// A list with bullets, as the page's ul: each item 4 pixels apart, set in by 20. `ownWay`:
    /// each item reads in the direction of its first letter, as dir="auto" has it -- for what the
    /// engine says, which is in English where its words are not in the language chosen, and would
    /// be put in the wrong order right to left.
    /// </summary>
    public static StackPanel Bullets(IEnumerable<string> items, double fontSize = 15, double lineHeight = 23, bool ownWay = false)
    {
        var list = new StackPanel();
        foreach (var item in items)
        {
            var bullet = Build.Text("\u2022");
            bullet.FontSize = fontSize;
            bullet.LineHeight = lineHeight;
            bullet.Width = 20;
            bullet.TextAlignment = TextAlignment.Center;
            bullet.Margin = new Thickness(-2, 0, 2, 0);
            var words = Build.Text(item);
            words.FontSize = fontSize;
            words.LineHeight = lineHeight;
            var row = new DockPanel { Margin = new Thickness(0, list.Children.Count == 0 ? 0 : 4, 0, 0) };
            DockPanel.SetDock(bullet, Dock.Left);
            row.Children.Add(bullet);
            row.Children.Add(words);
            if (ownWay) row.FlowDirection = RightToLeftFirst(item) ? FlowDirection.RightToLeft : FlowDirection.LeftToRight;
            list.Children.Add(row);
        }
        return list;
    }

    /// <summary>Whether the first letter of a text is of a script written right to left: Hebrew, Arabic and theirs.</summary>
    static bool RightToLeftFirst(string text)
    {
        foreach (var c in text)
        {
            if (c is >= '\u0590' and <= '\u08FF' or >= '\uFB1D' and <= '\uFDFF' or >= '\uFE70' and <= '\uFEFF') return true;
            if (char.IsLetter(c)) return false;
        }
        return Tr.Instance.Direction == FlowDirection.RightToLeft;
    }
}

/// <summary>
/// A card that assistive technology knows as a group named by its heading, as the page's
/// section aria-labelledby is a region: what is in it is heard as being in it.
/// </summary>
public sealed class Region : Border
{
    public Region(string name)
    {
        SetResourceReference(StyleProperty, "PanelCard");
        AutomationProperties.SetName(this, name);
    }

    protected override AutomationPeer OnCreateAutomationPeer() => new RegionPeer(this);

    sealed class RegionPeer(Region owner) : FrameworkElementAutomationPeer(owner)
    {
        protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.Group;
        protected override string GetClassNameCore() => "Region";
        protected override bool IsControlElementCore() => true;
    }
}
