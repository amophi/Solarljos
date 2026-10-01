using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Solarljos.Core;
using Solarljos.Ui;

namespace Solarljos.Views.Folder;

/// <summary>
/// One view of the part, as the page keeps one per route (a slot's view in src/gui/ui/app.js):
/// what it shows, its heading, the job it shows if any, and what it held, for when it is made
/// again in another language.
/// </summary>
public class Part
{
    public FrameworkElement El { get; protected init; } = new Border();
    public string Heading { get; protected init; } = "";
    public Job? Job { get; protected init; }

    protected Part() { }

    public Part(FrameworkElement el, string heading, Job? job = null)
    {
        El = el;
        Heading = heading;
        Job = job;
    }

    /// <summary>Draws again what its job now says: a step further, or more of it here.</summary>
    public virtual void Update() { }

    /// <summary>What it holds, to make it again as it was; null for nothing.</summary>
    public virtual object? Save() => null;

    /// <summary>It comes into sight again: what may have changed meanwhile is said again.</summary>
    public virtual void OnShow() { }

    /// <summary>It is let go of: what it listens to, it stops listening to.</summary>
    public virtual void Teardown() { }

    /// <summary>Where it scrolls: its own scroller, the page's.</summary>
    public ScrollViewer? Scroller => Find<ScrollViewer>(El);

    /// <summary>Its first heading, where a screen reader starts on a view shown for the first time.</summary>
    public TextBlock? HeadingBlock => FindHeading(El);

    static T? Find<T>(DependencyObject d) where T : DependencyObject
    {
        if (d is T t) return t;
        if (d is ContentControl { Content: DependencyObject c } && Find<T>(c) is { } inContent) return inContent;
        if (d is Decorator { Child: { } child } && Find<T>(child) is { } inChild) return inChild;
        if (d is Panel p)
        {
            foreach (UIElement e in p.Children)
                if (Find<T>(e) is { } inPanel) return inPanel;
        }
        if (d is ScrollViewer { Content: DependencyObject sc } && Find<T>(sc) is { } inScroll) return inScroll;
        return null;
    }

    static TextBlock? FindHeading(DependencyObject d)
    {
        if (d is TextBlock tb && System.Windows.Automation.AutomationProperties.GetHeadingLevel(tb) == System.Windows.Automation.AutomationHeadingLevel.Level1) return tb;
        if (d is ContentControl { Content: DependencyObject c } && FindHeading(c) is { } a) return a;
        if (d is Decorator { Child: { } child } && FindHeading(child) is { } b) return b;
        if (d is Panel p)
        {
            foreach (UIElement e in p.Children)
                if (FindHeading(e) is { } inPanel) return inPanel;
        }
        return null;
    }
}

/// <summary>Small pieces the views of the part share, as the page's own helpers are.</summary>
static class Bits
{
    /// <summary>The page's btn small: a button of a toolbar or a row.</summary>
    public static Button Small(string text, Action onClick, string style = "Btn")
    {
        var b = Build.Button(text, onClick, style);
        b.MinHeight = 32;
        b.MinWidth = 32;
        b.Padding = new Thickness(12, 4, 12, 4);
        b.FontSize = 14;
        Look.SetRadius(b, new CornerRadius(8));
        return b;
    }

    /// <summary>A path's font: the page's --mono.</summary>
    public static readonly FontFamily Mono = new("Cascadia Mono, Consolas, Segoe UI");

    /// <summary>A path in words: left to right in any language, in the mono font.</summary>
    public static TextBlock PathText(string path, double size = 13)
    {
        var t = Build.Text(path, "Muted");
        t.FontFamily = Mono;
        t.FontSize = size;
        t.LineHeight = double.NaN;
        t.FlowDirection = FlowDirection.LeftToRight;
        t.TextWrapping = TextWrapping.Wrap;
        return t;
    }

    /// <summary>
    /// The direction a name reads in, from its first letter that has one (the page isolates a
    /// name in a bdi): a name in Arabic or Hebrew right to left, any other left to right.
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

    /// <summary>A section of a card, its title a level-2 heading at the page's 17 pixels.</summary>
    public static Border Panel(string title, params UIElement?[] body)
    {
        var h = Build.Heading(title, 2);
        h.FontSize = 17;
        h.Margin = new Thickness(0, 0, 0, 8);
        var all = new List<UIElement?> { h };
        all.AddRange(body);
        var card = Build.Card(Build.Stack(all.ToArray()), 24);
        System.Windows.Automation.AutomationProperties.SetName(card, title);
        return card;
    }
}
