using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;

namespace Solarljos.Views.Media;

/// <summary>
/// One photo or video of the grid (tile() in src/gui/ui/app.js and its .tile rules in style.css):
/// a square of its picture, cut to fill it, with the kind of copy at its foot, a play mark for a
/// video and the box that selects it at its top end; its date and size below. What it says is in
/// its name for assistive technology, which reads it as an item that is selected or not, and that
/// opens; what it shows is for the eye only. A tile is used again for another copy as the grid
/// scrolls (Bind).
/// </summary>
public sealed class Tile : Grid
{
    static Tr T => Tr.Instance;

    readonly Grid frameHost = new();
    readonly Border frame = new() { CornerRadius = new CornerRadius(14) };
    // The picture itself, never mirrored right to left as the layout around it is.
    readonly Border photo = new() { CornerRadius = new CornerRadius(14), FlowDirection = FlowDirection.LeftToRight };
    readonly Border ring = new() { IsHitTestVisible = false, Visibility = Visibility.Collapsed };
    readonly Border focusRing = new() { IsHitTestVisible = false, Visibility = Visibility.Collapsed, CornerRadius = new CornerRadius(18), BorderThickness = new Thickness(2), Margin = new Thickness(-4) };
    readonly StackPanel words = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(8) };
    readonly TextBlock wordsLine = new() { FontSize = 13, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center };
    readonly TextBlock formatLine = new() { FontSize = 13, FontWeight = FontWeights.Bold, TextAlignment = TextAlignment.Center, Margin = new Thickness(0, 2, 0, 0) };
    readonly Border badge = new() { CornerRadius = new CornerRadius(8), Padding = new Thickness(7, 2, 8, 2), Margin = new Thickness(8), HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Bottom };
    readonly Icon badgeIcon = new() { Width = 13, Height = 13, Thickness = 2.2, Margin = new Thickness(0, 1, 4, 0), VerticalAlignment = VerticalAlignment.Top };
    readonly TextBlock badgeText = new() { FontSize = 12, FontWeight = FontWeights.Bold, TextWrapping = TextWrapping.Wrap, LineHeight = 16 };
    readonly Border play = new() { Width = 44, Height = 44, CornerRadius = new CornerRadius(22), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    readonly Border pick = new() { Width = 24, Height = 24, CornerRadius = new CornerRadius(6), BorderThickness = new Thickness(2), Margin = new Thickness(8), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Opacity = 0, Cursor = Cursors.Hand };
    readonly Icon pickIcon = new() { Glyph = "check", Width = 14, Height = 14, Thickness = 2.8, Opacity = 0 };
    readonly TextBlock caption = new() { FontSize = 13, LineHeight = 18, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(4, 6, 4, 0) };
    bool selected;
    bool keyboardRing;
    bool forcedRing;
    bool pressed;
    string label = "";

    /// <summary>The copy it shows now.</summary>
    public Copy Copy { get; private set; } = new();

    /// <summary>A click on it: on its pick box (`onPick`) or anywhere else, with the keys held.</summary>
    public event Action<Tile, bool>? Clicked;
    /// <summary>Assistive technology asked for it to be opened, selected or not.</summary>
    public event Action<Tile>? Invoked;
    public event Action<Tile, bool>? SelectRequested;
    public event Action<Tile>? Focused;

    public Tile(ResourceDictionary look)
    {
        Focusable = true;
        FocusVisualStyle = null;
        Cursor = Cursors.Hand;
        Background = Brushes.Transparent;
        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        frame.SetResourceReference(Border.BackgroundProperty, "Card");
        RenderOptions.SetBitmapScalingMode(photo, BitmapScalingMode.HighQuality);
        wordsLine.SetResourceReference(TextBlock.ForegroundProperty, "Text2");
        formatLine.SetResourceReference(TextBlock.ForegroundProperty, "Text2");
        formatLine.FontFamily = new FontFamily("Cascadia Mono, Consolas, Segoe UI");
        words.Children.Add(wordsLine);
        words.Children.Add(formatLine);

        var badgeRow = new DockPanel();
        DockPanel.SetDock(badgeIcon, Dock.Left);
        badgeRow.Children.Add(badgeIcon);
        badgeRow.Children.Add(badgeText);
        badge.Child = badgeRow;

        // Marks that do not turn right to left, as on the page: a check mark, the play triangle, the sign of a copy.
        badgeIcon.FlowDirection = FlowDirection.LeftToRight;
        pickIcon.FlowDirection = FlowDirection.LeftToRight;
        var playIcon = new Icon { Glyph = "play", Filled = true, Width = 20, Height = 20, Margin = new Thickness(2, 0, 0, 0), FlowDirection = FlowDirection.LeftToRight };
        playIcon.SetResourceReference(Icon.ForegroundProperty, "OnFill");
        play.Child = playIcon;
        play.Background = (Brush)look["PhotoScrim"];

        pick.Background = (Brush)look["PhotoScrim"];
        pick.SetResourceReference(Border.BorderBrushProperty, "OnFill");
        pickIcon.SetResourceReference(Icon.ForegroundProperty, "OnFill");
        pick.Child = pickIcon;
        pick.ToolTip = T["grid.select"];

        var inside = new Grid();
        inside.Children.Add(photo);
        inside.Children.Add(words);
        inside.Children.Add(badge);
        inside.Children.Add(play);
        inside.Children.Add(pick);
        frame.Child = inside;
        frameHost.Children.Add(frame);
        frameHost.Children.Add(ring);
        frameHost.Children.Add(focusRing);
        focusRing.SetResourceReference(Border.BorderBrushProperty, "Focus");
        Children.Add(frameHost);
        caption.SetResourceReference(TextBlock.ForegroundProperty, "Text2");
        caption.FontFeatures();
        SetRow(caption, 1);
        Children.Add(caption);

        MouseEnter += (_, _) => Restyle();
        MouseLeave += (_, _) =>
        {
            pressed = false;
            Restyle();
        };
        // A click is a press and its release on the same tile.
        MouseLeftButtonDown += (_, _) => pressed = true;
        MouseLeftButtonUp += (_, e) =>
        {
            if (!pressed) return;
            pressed = false;
            bool onPick = e.OriginalSource is DependencyObject d && IsIn(d, pick);
            e.Handled = true;
            Clicked?.Invoke(this, onPick);
        };
        GotKeyboardFocus += (_, _) =>
        {
            // The ring the page draws for :focus-visible: where the keyboard put the focus, not a click.
            keyboardRing = InputManager.Current.MostRecentInputDevice is KeyboardDevice;
            Restyle();
            Focused?.Invoke(this);
        };
        LostKeyboardFocus += (_, _) =>
        {
            keyboardRing = false;
            Restyle();
        };
    }

    static bool IsIn(DependencyObject d, DependencyObject ancestor)
    {
        for (var at = d; at is not null; at = VisualTreeHelper.GetParent(at)) if (at == ancestor) return true;
        return false;
    }

    /// <summary>Shows a copy: its words, its marks, and "Loading…" until its picture comes.</summary>
    public void Bind(Copy c, bool isSelected)
    {
        Copy = c;
        var tier = c.Tier;
        var colours = tier switch
        {
            "exact" => "Exact", "inexact" => "Inexact", "draft" => "Draft", "unverified" => "Unverified", "derived" => "Derived", _ => "Neutral",
        };
        badge.SetResourceReference(Border.BackgroundProperty, colours + "Bg");
        badgeText.SetResourceReference(TextBlock.ForegroundProperty, colours + "Text");
        badgeIcon.SetResourceReference(Icon.ForegroundProperty, colours + "Text");
        badgeIcon.Glyph = Formats.TierIcon(tier);
        // The kind of copy alone: its size in pixels is said in its name, and when it is opened.
        badgeText.Text = T["tier." + tier];
        play.Visibility = MediaData.IsVideo(c) ? Visibility.Visible : Visibility.Collapsed;
        caption.Text = (c.When is { } at ? Formats.Day(at) : T["grid.noDate"]) + " · " + Formats.Size(c.Size);
        label = MediaData.TileLabel(c);
        AutomationProperties.SetName(this, label);
        pick.ToolTip = T["grid.select"];
        ShowLoading();
        forcedRing = false;
        pressed = false;
        SetSelected(isSelected, false);
    }

    public bool IsSelectedTile => selected;

    public void SetSelected(bool on, bool say = true)
    {
        bool was = selected;
        selected = on;
        Restyle();
        if (say && was != on && UIElementAutomationPeer.FromElement(this) is TilePeer peer)
            peer.RaisePropertyChangedEvent(SelectionItemPatternIdentifiers.IsSelectedProperty, was, on);
    }

    public void ShowLoading()
    {
        photo.Background = null;
        wordsLine.Text = T["grid.loadingThumb"];
        formatLine.Visibility = Visibility.Collapsed;
        words.Visibility = Visibility.Visible;
    }

    public void ShowPicture(BitmapSource picture)
    {
        photo.Background = new ImageBrush(picture) { Stretch = Stretch.UniformToFill, AlignmentX = AlignmentX.Center, AlignmentY = AlignmentY.Center };
        words.Visibility = Visibility.Collapsed;
    }

    /// <summary>What cannot be shown says so, with its format, from what its first bytes are.</summary>
    public void ShowNone(string? ext)
    {
        photo.Background = null;
        wordsLine.Text = T["grid.noThumb"];
        formatLine.Text = ext is { Length: > 0 } ? Formats.FormatName(ext) : "";
        formatLine.Visibility = ext is { Length: > 0 } ? Visibility.Visible : Visibility.Collapsed;
        words.Visibility = Visibility.Visible;
    }

    void Restyle()
    {
        bool hover = IsMouseOver;
        if (selected)
        {
            ring.Visibility = Visibility.Visible;
            ring.SetResourceReference(Border.BorderBrushProperty, "Accent");
            ring.BorderThickness = new Thickness(3);
            ring.Margin = new Thickness(-3);
            ring.CornerRadius = new CornerRadius(17);
        }
        else if (hover)
        {
            ring.Visibility = Visibility.Visible;
            ring.SetResourceReference(Border.BorderBrushProperty, "FieldLineHover");
            ring.BorderThickness = new Thickness(2);
            ring.Margin = new Thickness(-2);
            ring.CornerRadius = new CornerRadius(16);
        }
        else
        {
            ring.Visibility = Visibility.Collapsed;
        }
        focusRing.Visibility = (keyboardRing && IsKeyboardFocused) || forcedRing ? Visibility.Visible : Visibility.Collapsed;
        pick.Opacity = hover || selected || focusRing.Visibility == Visibility.Visible ? 1 : 0;
        if (selected) pick.SetResourceReference(Border.BackgroundProperty, "Accent");
        else pick.Background = play.Background;
        pickIcon.Opacity = selected ? 1 : 0;
    }

    /// <summary>The keyboard's ring drawn whatever has the focus: for the pictures of the window, which is never active.</summary>
    public void Ring(bool on)
    {
        forcedRing = on;
        Restyle();
    }

    /// <summary>The picture is a square as wide as its column.</summary>
    protected override Size MeasureOverride(Size constraint)
    {
        if (!double.IsInfinity(constraint.Width) && constraint.Width > 0) frameHost.Height = constraint.Width;
        return base.MeasureOverride(constraint);
    }

    protected override AutomationPeer OnCreateAutomationPeer() => new TilePeer(this);

    internal void Invoke() => Invoked?.Invoke(this);

    internal void AskSelected(bool on) => SelectRequested?.Invoke(this, on);

    /// <summary>The grid it is drawn in; none while it waits to be used again.</summary>
    GridList? Holder()
    {
        for (var at = VisualTreeHelper.GetParent(this); at is not null; at = VisualTreeHelper.GetParent(at)) if (at is GridList list) return list;
        return null;
    }

    /// <summary>A tile to assistive technology: an item, named by what it shows, that is selected or not and that opens.</summary>
    sealed class TilePeer(Tile owner) : FrameworkElementAutomationPeer(owner), ISelectionItemProvider, IInvokeProvider
    {
        protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.ListItem;

        protected override string GetClassNameCore() => "Tile";

        protected override string GetNameCore() => owner.label;

        protected override bool IsKeyboardFocusableCore() => true;

        public override object GetPattern(PatternInterface p) => p is PatternInterface.SelectionItem or PatternInterface.Invoke ? this : base.GetPattern(p)!;

        public bool IsSelected => owner.selected;

        /// <summary>The grid it is drawn in, which says that several can be selected, and which are.</summary>
        public IRawElementProviderSimple? SelectionContainer =>
            owner.Holder() is { } list && UIElementAutomationPeer.CreatePeerForElement(list) is { } peer ? ProviderFromPeer(peer) : null;

        public void Select() => owner.AskSelected(true);

        public void AddToSelection() => owner.AskSelected(true);

        public void RemoveFromSelection() => owner.AskSelected(false);

        public void Invoke() => owner.Invoke();
    }
}

/// <summary>A row of tiles, each as wide as the others, 8 pixels between them (the page's .grid-row).</summary>
public sealed class TileRowPanel : Panel
{
    public const double Gap = 8;

    public int Columns { get; set; } = 4;

    double ColumnWidth(double width) => Math.Max(0, (width - Gap * (Columns - 1)) / Math.Max(1, Columns));

    protected override Size MeasureOverride(Size available)
    {
        double w = double.IsInfinity(available.Width) ? 160 * Columns : available.Width;
        double col = ColumnWidth(w), high = 0;
        foreach (UIElement c in InternalChildren)
        {
            c.Measure(new Size(col, double.PositiveInfinity));
            high = Math.Max(high, c.DesiredSize.Height);
        }
        return new Size(w, high + Gap);
    }

    protected override Size ArrangeOverride(Size final)
    {
        double col = ColumnWidth(final.Width);
        int i = 0;
        foreach (UIElement c in InternalChildren)
        {
            c.Arrange(new Rect(i * (col + Gap), 0, col, Math.Max(0, final.Height - Gap)));
            i++;
        }
        return final;
    }
}

/// <summary>Words for the eye only, which assistive technology does not see: a heading already said where it is.</summary>
public sealed class SilentText : TextBlock
{
    protected override AutomationPeer? OnCreateAutomationPeer() => null;
}

static class TextBlockLook
{
    /// <summary>Digits of one width, so that dates and sizes line up (font-variant-numeric: tabular-nums).</summary>
    public static void FontFeatures(this TextBlock t) => System.Windows.Documents.Typography.SetNumeralAlignment(t, FontNumeralAlignment.Tabular);
}
