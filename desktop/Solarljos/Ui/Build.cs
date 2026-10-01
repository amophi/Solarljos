using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using Solarljos.Core;
using Solarljos.Text;

namespace Solarljos.Ui;

/// <summary>
/// The pieces every part of the window is made of, built in code as the page builds them
/// (src/gui/ui/app.js, "building the page"): words, fields with their hints and errors, switches,
/// chips, check boxes, cards that open, messages, badges. Each says to assistive technology what
/// it is and what it holds; colours and type come from the theme (Theme/Styles.xaml).
/// </summary>
public static class Build
{
    static Tr T => Tr.Instance;

    public static TextBlock Text(string text, string style = "Body")
    {
        var tb = new TextBlock { Text = text };
        tb.SetResourceReference(FrameworkElement.StyleProperty, style);
        return tb;
    }

    /// <summary>A heading: level 1 for a part's own, 2 for one inside it.</summary>
    public static TextBlock Heading(string text, int level = 1)
    {
        var tb = Text(text, level == 1 ? "H1" : "H2");
        AutomationProperties.SetHeadingLevel(tb, level == 1 ? AutomationHeadingLevel.Level1 : AutomationHeadingLevel.Level2);
        return tb;
    }

    public static StackPanel Stack(params UIElement?[] items) => Stack(Orientation.Vertical, items);

    public static StackPanel Stack(Orientation o, params UIElement?[] items)
    {
        var s = new StackPanel { Orientation = o };
        foreach (var i in items) if (i is not null) s.Children.Add(i);
        return s;
    }

    public static T2 Margin<T2>(this T2 e, double left, double top, double right, double bottom) where T2 : FrameworkElement
    {
        e.Margin = new Thickness(left, top, right, bottom);
        return e;
    }

    public static Button Button(string text, Action onClick, string style = "Btn", string? glyph = null)
    {
        var b = new Button { Content = text };
        b.SetResourceReference(FrameworkElement.StyleProperty, style);
        if (glyph is not null) Look.SetGlyph(b, glyph);
        b.Click += (_, _) => onClick();
        return b;
    }

    /// <summary>A box to type in.</summary>
    public static TextBox Input(string value = "")
    {
        var t = new TextBox { Text = value };
        SpellCheck.SetIsEnabled(t, false);
        return t;
    }

    /// <summary>
    /// A box for a folder's whole path, read left to right in any language. Typed or pasted:
    /// Explorer's "Copy as path" puts it in quotes, which the engine takes off.
    /// </summary>
    public static TextBox PathBox(string value = "")
    {
        var t = Input(value);
        t.FlowDirection = FlowDirection.LeftToRight;
        t.FontFamily = new FontFamily("Cascadia Mono, Consolas, Segoe UI");
        t.FontSize = 14;
        return t;
    }

    // ---- a field: its label, its control, a hint below, and an error ------------------------

    public sealed class Field
    {
        public required StackPanel El { get; init; }
        public required FrameworkElement Control { get; init; }
        public required TextBlock Error { get; init; }
        public string? Hint { get; init; }

        /// <summary>Says what is wrong with what was given, below it, and to assistive technology; null takes it away.</summary>
        public void SetError(string? message)
        {
            Error.Text = message is null ? "" : "! " + message;
            Error.Visibility = message is null ? Visibility.Collapsed : Visibility.Visible;
            AutomationProperties.SetHelpText(Control, string.Join(" ", new[] { message, Hint }.Where((s) => !string.IsNullOrEmpty(s))));
            if (message is not null) Announce.Alert(message);
        }
    }

    public static Field LabeledField(string label, FrameworkElement control, string? hint = null, bool optional = false, UIElement? beside = null)
    {
        var name = new TextBlock { FontSize = 16, FontWeight = FontWeights.Bold, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 8) };
        name.SetResourceReference(TextBlock.ForegroundProperty, "Text");
        name.Inlines.Add(new System.Windows.Documents.Run(label));
        if (optional)
        {
            var aside = new System.Windows.Documents.Run(" " + T["common.optional"]) { FontWeight = FontWeights.Normal, FontSize = 14 };
            aside.SetResourceReference(System.Windows.Documents.TextElement.ForegroundProperty, "Text2");
            name.Inlines.Add(aside);
        }
        AutomationProperties.SetLabeledBy(control, name);
        AutomationProperties.SetName(control, label);
        if (hint is not null) AutomationProperties.SetHelpText(control, hint);
        var error = new TextBlock { FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0), Visibility = Visibility.Collapsed };
        error.SetResourceReference(TextBlock.ForegroundProperty, "DangerText");
        var row = beside is null ? (UIElement)control : Stack(Orientation.Horizontal, control, beside);
        var el = Stack(name, row, hint is null ? null : Text(hint, "Hint").Margin(0, 8, 0, 0), error);
        el.Margin = new Thickness(0, 0, 0, 24);
        return new Field { El = el, Control = control, Error = error, Hint = hint };
    }

    // ---- a switch, for one setting that is on or off ----------------------------------------

    public sealed class SwitchRow
    {
        public required Border El { get; init; }
        public required CheckBox Input { get; init; }
        public required StackPanel Words { get; init; }
        public bool IsOn { get => Input.IsChecked == true; set => Input.IsChecked = value; }
        public event Action? Changed;
        internal void Fire() => Changed?.Invoke();
    }

    /// <summary>
    /// A setting as SoundVisualizer's are: its name and, below it, what it does, with the switch at
    /// the end of the row, and the whole row to click. `compact`: one line, in a toolbar.
    /// </summary>
    public static SwitchRow Switch(string label, bool on, string? hint = null, bool compact = false)
    {
        var input = new CheckBox { IsChecked = on, VerticalAlignment = compact ? VerticalAlignment.Center : VerticalAlignment.Top };
        input.SetResourceReference(FrameworkElement.StyleProperty, "Switch");
        AutomationProperties.SetName(input, label);
        if (hint is not null) AutomationProperties.SetHelpText(input, hint);
        var name = new TextBlock
        {
            Text = label, FontSize = compact ? 15 : 16, FontWeight = compact ? FontWeights.SemiBold : FontWeights.Bold,
            TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center,
        };
        name.SetResourceReference(TextBlock.ForegroundProperty, "Text");
        var words = Stack(name, hint is null ? null : Text(hint, "Hint").Margin(0, 8, 0, 0));
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.Children.Add(words);
        Grid.SetColumn(input, 1);
        input.Margin = new Thickness(compact ? 12 : 16, 0, 0, 0);
        grid.Children.Add(input);
        var box = new Border
        {
            Child = grid, CornerRadius = new CornerRadius(compact ? 10 : 14),
            Padding = compact ? new Thickness(12, 4, 8, 4) : new Thickness(16, 14, 16, 14),
            Margin = compact ? new Thickness(0) : new Thickness(-16, 0, -16, 0), Background = Brushes.Transparent, Cursor = Cursors.Hand,
        };
        box.MouseEnter += (_, _) => box.SetResourceReference(Border.BackgroundProperty, "Hover");
        box.MouseLeave += (_, _) => box.Background = Brushes.Transparent;
        var row = new SwitchRow { El = box, Input = input, Words = words };
        box.MouseLeftButtonUp += (_, e) =>
        {
            if (e.OriginalSource is DependencyObject d && IsInside(d, input)) return;
            input.IsChecked = !(input.IsChecked == true);
            input.Focus();
        };
        input.Checked += (_, _) => row.Fire();
        input.Unchecked += (_, _) => row.Fire();
        return row;
    }

    static bool IsInside(DependencyObject d, DependencyObject ancestor)
    {
        for (var at = d; at is not null; at = VisualTreeHelper.GetParent(at)) if (at == ancestor) return true;
        return false;
    }

    // ---- chips, for one choice among a few --------------------------------------------------

    public sealed class Chips
    {
        public required StackPanel El { get; init; }
        public required List<RadioButton> Inputs { get; init; }
        public string Value
        {
            get => (string?)Inputs.FirstOrDefault((r) => r.IsChecked == true)?.Tag ?? "";
            set { foreach (var r in Inputs) r.IsChecked = (string)r.Tag == value; }
        }
        public event Action? Changed;
        internal void Fire() => Changed?.Invoke();
    }

    /// <summary>
    /// A choice of one among a few, as chips, the chosen one filled (the page's .radios): each a
    /// radio button, of a group named by its legend. `inline`: the legend beside them, smaller.
    /// </summary>
    public static Chips ChipGroup(string legend, IEnumerable<(string Value, string Label)> choices, string selected, string? hint = null, bool inline = false)
    {
        var group = "chips-" + Guid.NewGuid().ToString("N");
        var wrap = new WrapPanel { Orientation = Orientation.Horizontal };
        var inputs = new List<RadioButton>();
        var title = new TextBlock
        {
            Text = legend, FontSize = inline ? 15 : 16, FontWeight = inline ? FontWeights.SemiBold : FontWeights.Bold,
            TextWrapping = TextWrapping.Wrap, Margin = inline ? new Thickness(0, 0, 8, 8) : new Thickness(0, 0, 0, 12),
            VerticalAlignment = VerticalAlignment.Center,
        };
        title.SetResourceReference(TextBlock.ForegroundProperty, inline ? "Text2" : "Text");
        if (inline) wrap.Children.Add(title);
        var chips = new Chips { El = new StackPanel(), Inputs = inputs };
        foreach (var (value, label) in choices)
        {
            var r = new RadioButton { Content = label, Tag = value, GroupName = group, IsChecked = value == selected, Margin = new Thickness(0, 0, 8, 8) };
            r.SetResourceReference(FrameworkElement.StyleProperty, inline ? "ChipSmall" : "Chip");
            r.Checked += (_, _) => chips.Fire();
            inputs.Add(r);
            wrap.Children.Add(r);
        }
        if (!inline) chips.El.Children.Add(title);
        // Named by its legend, as a fieldset is: "Any time, radio button" says from when.
        chips.El.Children.Add(Labeled.Group(legend, wrap));
        if (hint is not null) chips.El.Children.Add(Text(hint, "Hint").Margin(0, 0, 0, 0));
        return chips;
    }

    // ---- a check box, for choosing several --------------------------------------------------

    public static CheckBox Check(string label, bool on, string? hint = null)
    {
        var c = new CheckBox { IsChecked = on, Content = new TextBlock { Text = label, TextWrapping = TextWrapping.Wrap } };
        AutomationProperties.SetName(c, label);
        if (hint is not null) AutomationProperties.SetHelpText(c, hint);
        return c;
    }

    // ---- a list to choose from --------------------------------------------------------------

    public static ComboBox Select(IEnumerable<(string Value, string Label)> choices, string selected, string? name = null)
    {
        var box = new ComboBox { DisplayMemberPath = "Label", SelectedValuePath = "Value", MinWidth = 256, HorizontalAlignment = HorizontalAlignment.Left };
        box.ItemsSource = choices.Select((c) => new Choice(c.Value, c.Label)).ToList();
        box.SelectedValue = selected;
        if (name is not null) AutomationProperties.SetName(box, name);
        return box;
    }

    public sealed record Choice(string Value, string Label)
    {
        public override string ToString() => Label;
    }

    // ---- a card of more options, which opens when its title is clicked ----------------------

    /// <summary>
    /// The page's details.more (and, with `card`, details.expander): the title and an arrow, down
    /// when it is closed and up when it is open, the whole title to click.
    /// </summary>
    public static Expander More(string title, bool open, bool card = false, params UIElement?[] body)
    {
        var content = Stack(body);
        content.Margin = new Thickness(24, 0, 24, 24);
        var e = new Expander { Header = title, IsExpanded = open, Content = content };
        e.SetResourceReference(FrameworkElement.StyleProperty, card ? "ExpanderCard" : "MoreCard");
        AutomationProperties.SetName(e, title);
        return e;
    }

    // ---- messages and labels ----------------------------------------------------------------

    /// <summary>A message in a box of its kind -- error, warn, info, plain, success -- with its icon, a title and what it says.</summary>
    public static Border Callout(string kind, string? title, params UIElement?[] body)
    {
        var (bg, accent) = kind switch
        {
            "error" => ("ErrorBg", "DangerText"),
            "warn" => ("WarnBg", "Warning"),
            "info" => ("InfoBg", "AccentText"),
            "success" => ("SuccessBg", "Success"),
            _ => ("PlainBg", "Text2"),
        };
        var glyph = kind switch { "error" => "error", "warn" => "alert", "success" => "success", _ => "info" };
        var icon = new Icon { Glyph = glyph, Width = 22, Height = 22, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 0, 12, 0) };
        icon.SetResourceReference(Icon.ForegroundProperty, accent);
        var words = new StackPanel();
        if (title is not null)
        {
            var t = Text(title, "Body");
            t.FontWeight = FontWeights.Bold;
            if (kind is "error" or "warn") t.SetResourceReference(TextBlock.ForegroundProperty, accent);
            words.Children.Add(t);
        }
        foreach (var b in body)
        {
            if (b is null) continue;
            if (words.Children.Count > 0 && b is FrameworkElement fe && fe.Margin == default) fe.Margin = new Thickness(0, 4, 0, 0);
            words.Children.Add(b);
        }
        if (kind == "warn")
        {
            foreach (var tb in words.Children.OfType<TextBlock>())
            {
                tb.SetResourceReference(TextBlock.ForegroundProperty, "Warning");
                tb.FontSize = 14;
            }
        }
        var dock = new DockPanel();
        DockPanel.SetDock(icon, Dock.Left);
        dock.Children.Add(icon);
        dock.Children.Add(words);
        var box = new Border { Child = dock, CornerRadius = new CornerRadius(14), Padding = new Thickness(20, 16, 20, 16), Margin = new Thickness(0, 8, 0, 8) };
        box.SetResourceReference(Border.BackgroundProperty, bg);
        return box;
    }

    /// <summary>A pill: an icon beside the words, never instead of them, in the colours of what it says.</summary>
    public static Border Badge(string colours, string? glyph, string text)
    {
        var words = new TextBlock { Text = text, FontSize = 13, FontWeight = FontWeights.Bold, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
        words.SetResourceReference(TextBlock.ForegroundProperty, colours + "Text");
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        if (glyph is not null)
        {
            var icon = new Icon { Glyph = glyph, Width = 14, Height = 14, Thickness = 2.2, Margin = new Thickness(0, 0, 4, 0), VerticalAlignment = VerticalAlignment.Center };
            icon.SetResourceReference(Icon.ForegroundProperty, colours + "Text");
            row.Children.Add(icon);
        }
        row.Children.Add(words);
        var pill = new Border { Child = row, CornerRadius = new CornerRadius(999), Padding = new Thickness(8, 2, 10, 2), VerticalAlignment = VerticalAlignment.Center };
        pill.SetResourceReference(Border.BackgroundProperty, colours + "Bg");
        AutomationProperties.SetName(pill, text);
        return pill;
    }

    static string TierColours(string tier) => tier switch
    {
        "exact" => "Exact",
        "inexact" => "Inexact",
        "draft" => "Draft",
        "unverified" => "Unverified",
        "derived" => "Derived",
        _ => "Neutral",
    };

    /// <summary>A copy's quality as a pill, with what it means as its tooltip.</summary>
    public static Border TierBadge(Copy c)
    {
        var b = Badge(TierColours(c.Tier), Formats.TierIcon(c.Tier), Formats.TierText(c));
        b.ToolTip = Formats.TierHelp(c);
        AutomationProperties.SetHelpText(b, Formats.TierHelp(c));
        return b;
    }

    /// <summary>Whether the file is still where it was: deleted, still there, or that cannot be told.</summary>
    public static Border StateBadge(string state)
    {
        var colours = state switch { "deleted" => "Deleted", "exists" => "Exists", _ => "Neutral" };
        var b = Badge(colours, null, Formats.StateText(state));
        b.ToolTip = Formats.StateHelp(state);
        AutomationProperties.SetHelpText(b, Formats.StateHelp(state));
        return b;
    }

    /// <summary>Two options side by side where they fit.</summary>
    public static PairPanel Pair(params UIElement?[] items)
    {
        var p = new PairPanel { Margin = new Thickness(0, 0, 0, 24) };
        foreach (var i in items) if (i is not null) p.Children.Add(i);
        return p;
    }

    /// <summary>A card: the cards' colour, its corners round, room inside.</summary>
    public static Border Card(UIElement child, double padding = 24)
    {
        var b = new Border { Child = child, Padding = new Thickness(padding) };
        b.SetResourceReference(FrameworkElement.StyleProperty, "PanelCard");
        b.Padding = new Thickness(padding);
        return b;
    }

    /// <summary>A page's own scroller, its content as wide as the page has it (1,120 pixels), from the start.</summary>
    public static ScrollViewer Page(UIElement content, double maxWidth = 1120)
    {
        var holder = new Border { Child = content, MaxWidth = maxWidth, Margin = new Thickness(40, 40, 40, 96) };
        return new ScrollViewer { Content = holder, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Focusable = false };
    }
}
