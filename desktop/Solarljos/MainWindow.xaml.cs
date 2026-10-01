using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views;

namespace Solarljos;

public partial class MainWindow : Window
{
    // The rail shows its words in a window this wide or more (the page's WIDE_RAIL).
    const double WideRail = 1008;

    enum RailMode { Expanded, Compact, Overlay }

    public static readonly DependencyProperty IsCompactProperty = DependencyProperty.Register(
        nameof(IsCompact), typeof(bool), typeof(MainWindow), new PropertyMetadata(false));

    /// <summary>The rail shows only its icons.</summary>
    public bool IsCompact { get => (bool)GetValue(IsCompactProperty); set => SetValue(IsCompactProperty, value); }

    // null: as the width says; Compact in a wide window, Overlay in a narrow one.
    RailMode? railWish;
    RailMode railMode = RailMode.Expanded;
    string? forcedRail;

    readonly Dictionary<string, IPage> pages = new();
    string section = "";
    Session? session;
    bool selecting;
    bool closing;

    /// <summary>Shows a part of the program's window, from wherever: "sources", "find/results".</summary>
    public static void Navigate(string route) => (Application.Current?.MainWindow as MainWindow)?.Go(route);

    public MainWindow()
    {
        InitializeComponent();
        var tr = Tr.Instance;
        Lang.ItemsSource = tr.Languages;
        Lang.SelectedValue = tr.Code;
        FlowDirection = tr.Direction;
        tr.Changed += () =>
        {
            FlowDirection = tr.Direction;
            ApplyTheme();
            UpdateTitle();
            ApplyRail();
        };
        Theme.Changed += ApplyTheme;
        SizeChanged += (_, _) => ApplyRail();
        SourceInitialized += (_, _) => Theme.TitleBar(this);
        PreviewKeyDown += OnKeys;
        Closing += OnClosing;
        ApplyTheme();
        Go("");
        ApplyRail();
        Spin(true);
    }

    /// <summary>
    /// The "Starting" mark turning, and stopped once it is hidden: an animation left running on a
    /// hidden element still has the window drawn sixty times a second for as long as it is open.
    /// </summary>
    void Spin(bool on)
    {
        var turn = on ? new System.Windows.Media.Animation.DoubleAnimation(0, 360, TimeSpan.FromSeconds(1)) { RepeatBehavior = System.Windows.Media.Animation.RepeatBehavior.Forever } : null;
        StartingTurn.BeginAnimation(System.Windows.Media.RotateTransform.AngleProperty, turn);
        if (!on) Starting.Visibility = Visibility.Collapsed;
    }

    // ---- the parts of the page ---------------------------------------------------------------

    IPage PageFor(string name)
    {
        if (pages.TryGetValue(name, out var page)) return page;
        page = name switch
        {
            "" => new HomeView(this),
            "find" => new FindView(),
            "media" => new MediaView(),
            "folder" => new FolderView(),
            "sources" => new SourcesView(),
            _ => new HelpView(),
        };
        page.HeadingChanged += UpdateTitle;
        if (session is not null) page.Connected(session);
        pages[name] = page;
        Pages.Children.Add((UIElement)page);
        return page;
    }

    /// <summary>Shows a part of the page: "find", "find/results", "" for the start.</summary>
    public void Go(string route)
    {
        var parts = (route ?? "").Split('/', 2);
        var name = parts[0];
        if (name is not ("" or "find" or "media" or "folder" or "sources" or "help")) name = "";
        var page = PageFor(name);
        section = name;
        foreach (var (key, p) in pages) ((UIElement)p).Visibility = key == name ? Visibility.Visible : Visibility.Collapsed;
        selecting = true;
        Nav.SelectedItem = Nav.Items.OfType<ListBoxItem>().FirstOrDefault((i) => (string)i.Tag == name);
        selecting = false;
        page.Shown(parts.Length > 1 ? parts[1] : "");
        CloseOverlay();
        UpdateTitle();
        var shown = (FrameworkElement)page;
        Dispatcher.BeginInvoke(System.Windows.Threading.DispatcherPriority.ContextIdle, () => FocusInto(shown));
    }

    /// <summary>
    /// When the focus was in the part just hidden, to the heading of the one shown, as the page
    /// does; a part that keeps its own place has put the focus there already, and on the rail it
    /// stays, for the arrow keys to go on along it.
    /// </summary>
    static void FocusInto(FrameworkElement page)
    {
        if (!page.IsVisible || Keyboard.FocusedElement is UIElement { IsVisible: true }) return;
        if (FirstHeading(page) is not { } h) return;
        h.Focusable = true;
        h.FocusVisualStyle = null;
        KeyboardNavigation.SetIsTabStop(h, false);
        Keyboard.Focus(h);
    }

    static TextBlock? FirstHeading(DependencyObject root)
    {
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
        {
            if (child is TextBlock { IsVisible: true } tb && System.Windows.Automation.AutomationProperties.GetHeadingLevel(tb) == System.Windows.Automation.AutomationHeadingLevel.Level1) return tb;
            if (FirstHeading(child) is { } found) return found;
        }
        return null;
    }

    void UpdateTitle()
    {
        var heading = pages.TryGetValue(section, out var p) ? p.Heading : null;
        Title = string.IsNullOrEmpty(heading) ? Tr.Instance["app.name"] : Tr.Instance.Get("app.pageTitle", ("page", heading));
    }

    void Nav_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (selecting || Nav.SelectedItem is not ListBoxItem item) return;
        Go((string)item.Tag);
    }

    void Brand_Click(object sender, RoutedEventArgs e) => Go("");

    /// <summary>Ctrl+1 to Ctrl+5 go to each part; Esc closes the rail's words over the page.</summary>
    void OnKeys(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape && railMode == RailMode.Overlay)
        {
            CloseOverlay();
            Toggle.Focus();
            e.Handled = true;
            return;
        }
        if (Keyboard.Modifiers != ModifierKeys.Control) return;
        int n = e.Key switch
        {
            >= Key.D1 and <= Key.D5 => e.Key - Key.D1,
            >= Key.NumPad1 and <= Key.NumPad5 => e.Key - Key.NumPad1,
            _ => -1,
        };
        if (n < 0) return;
        e.Handled = true;
        // The focus goes where the part puts it, or to its heading (FocusInto).
        var item = (ListBoxItem)Nav.Items[n];
        if (!item.IsSelected) Go((string)item.Tag);
    }

    // ---- the rail ----------------------------------------------------------------------------

    void Toggle_Click(object sender, RoutedEventArgs e)
    {
        bool wide = ActualWidth >= WideRail;
        if (wide) railWish = railWish == RailMode.Compact ? null : RailMode.Compact;
        else railWish = railWish == RailMode.Overlay ? null : RailMode.Overlay;
        ApplyRail();
    }

    void Scrim_MouseDown(object sender, MouseButtonEventArgs e) => CloseOverlay();

    void CloseOverlay()
    {
        if (railWish != RailMode.Overlay) return;
        railWish = null;
        ApplyRail();
    }

    /// <summary>For the pictures of the window: the rail as asked, whatever the width.</summary>
    public void ForceRail(string mode)
    {
        forcedRail = mode;
        ApplyRail();
    }

    void ApplyRail()
    {
        bool wide = ActualWidth >= WideRail || (ActualWidth == 0 && Width >= WideRail);
        var mode = wide ? (railWish == RailMode.Compact ? RailMode.Compact : RailMode.Expanded)
            : railWish == RailMode.Overlay ? RailMode.Overlay : RailMode.Compact;
        mode = forcedRail switch { "compact" => RailMode.Compact, "overlay" => RailMode.Overlay, "expanded" => RailMode.Expanded, _ => mode };
        railMode = mode;
        IsCompact = mode == RailMode.Compact;
        bool overlay = mode == RailMode.Overlay;
        Rail.MinWidth = IsCompact ? 0 : 256;
        Rail.Width = IsCompact ? 72 : double.NaN;
        // Over the page: the rail spans the window, its place kept at the width of its icons.
        RailColumn.Width = overlay ? new GridLength(72) : GridLength.Auto;
        Grid.SetColumnSpan(Rail, overlay ? 2 : 1);
        Rail.Effect = overlay ? new System.Windows.Media.Effects.DropShadowEffect { BlurRadius = 48, ShadowDepth = 8, Opacity = 0.4 } : null;
        Scrim.Visibility = overlay ? Visibility.Visible : Visibility.Collapsed;
        Toggle.IsExpanded = !IsCompact;
        RailTop.Orientation = IsCompact ? Orientation.Vertical : Orientation.Horizontal;
        BrandName.Visibility = IsCompact ? Visibility.Collapsed : Visibility.Visible;
        // Foot: the language and the theme side by side, one above the other with icons alone.
        Grid.SetColumn(ThemeButton, IsCompact ? 0 : 1);
        Grid.SetRow(ThemeButton, 0);
        if (IsCompact)
        {
            if (FootRow.RowDefinitions.Count == 0)
            {
                FootRow.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                FootRow.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            }
            Grid.SetRow(ThemeButton, 1);
            ThemeButton.Margin = new Thickness(0, 4, 0, 0);
            ThemeButton.HorizontalAlignment = HorizontalAlignment.Left;
            Lang.Margin = new Thickness(0);
            Lang.Opacity = 0;
            LangPick.Width = 48;
            LangPick.HorizontalAlignment = HorizontalAlignment.Left;
        }
        else
        {
            FootRow.RowDefinitions.Clear();
            ThemeButton.Margin = new Thickness(4, 0, 0, 0);
            Lang.Margin = new Thickness(36, 0, 0, 0);
            Lang.Opacity = 1;
            LangPick.Width = double.NaN;
            LangPick.HorizontalAlignment = HorizontalAlignment.Stretch;
        }
        // A rail of icons says what each is when it is pointed at.
        foreach (ListBoxItem item in Nav.Items)
            item.ToolTip = IsCompact ? System.Windows.Automation.AutomationProperties.GetName(item) : null;
        QuitButton.ToolTip = IsCompact ? Tr.Instance["nav.quit"] : null;
        LangPick.ToolTip = IsCompact ? Tr.Instance["lang.label"] : null;
    }

    // ---- the language, the theme, Quit -------------------------------------------------------

    async void Lang_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (Lang.SelectedValue is not string code || code == Tr.Instance.Code) return;
        Tr.Instance.Use(code);
        Theme.UseFontFor(code);
        var name = Tr.Instance.Languages.FirstOrDefault((l) => l.Code == code)?.Name ?? code;
        Announce.Say(Tr.Instance.Get("lang.changed", ("language", name)));
        if (session is not null) await session.UseLanguageAsync(code);
    }

    void Theme_Click(object sender, RoutedEventArgs e) => Theme.Use(!Theme.Dark);

    void ApplyTheme()
    {
        ThemeIcon.Glyph = Theme.Dark ? "sun" : "moon";
        var label = Tr.Instance[Theme.Dark ? "theme.toLight" : "theme.toDark"];
        System.Windows.Automation.AutomationProperties.SetName(ThemeButton, label);
        ThemeButton.ToolTip = label;
    }

    async void Quit_Click(object sender, RoutedEventArgs e)
    {
        // While a folder is being written, closing asks its own question (OnClosing), and only that.
        if (Writing())
        {
            Close();
            return;
        }
        var tr = Tr.Instance;
        bool ok = await Dialog.ConfirmAsync(this, tr["quit.confirmTitle"], tr["quit.confirmBody"], tr["nav.quit"], tr["common.cancel"], danger: true);
        if (ok) Close();
    }

    bool quitAnyway;

    /// <summary>
    /// The window closing, by Quit or its own close button. While a folder is being written the
    /// engine finishes it first: the window asks, and goes when told to, leaving the engine to
    /// stop once the files are done (App.WaitForWrites).
    /// </summary>
    async void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (quitAnyway || !Writing())
        {
            closing = true;
            return;
        }
        e.Cancel = true;
        var tr = Tr.Instance;
        if (!await Dialog.ConfirmAsync(this, tr["quit.confirmTitle"], tr["desktop.quit.writing"], tr["nav.quit"], tr["common.cancel"])) return;
        App.WaitForWrites = true;
        quitAnyway = true;
        // Not from inside Closing, which WPF refuses: once it has returned.
        _ = Dispatcher.BeginInvoke(Close);
    }

    bool Writing() => session?.Jobs.Current("rebuild") is { Running: true };

    // ---- the engine --------------------------------------------------------------------------

    public void Connected(Session s)
    {
        session = s;
        // A file of a folder's plan is shown on its own, in the preview the results have.
        FolderView.ShowPreview = (copy, opener) => Views.Shared.PreviewWindow.Show(s, copy, opener);
        Spin(false);
        foreach (var p in pages.Values) p.Connected(s);
    }

    public Task ActAsync(string? act) =>
        act is not null && pages.TryGetValue(section, out var p) ? p.ActAsync(act) : Task.CompletedTask;

    public void CoreMissing() => ShowFatal(Tr.Instance["desktop.missing.title"], Tr.Instance["desktop.missing.body"], null);

    public void CoreStopped(string said)
    {
        if (closing) return;
        ShowFatal(Tr.Instance["desktop.stopped.title"], Tr.Instance["desktop.stopped.body"], said);
    }

    void ShowFatal(string title, string body, string? said)
    {
        Spin(false);
        FatalTitle.Text = title;
        FatalBody.Text = body;
        bool any = !string.IsNullOrWhiteSpace(said);
        FatalSaidTitle.Visibility = FatalSaid.Visibility = any ? Visibility.Visible : Visibility.Collapsed;
        FatalSaid.Text = said ?? "";
        Fatal.Visibility = Visibility.Visible;
        // The part behind can do nothing now: out of reach, as behind the page's dialog; the
        // language and Quit stay.
        Pages.IsEnabled = false;
        Nav.IsEnabled = false;
        Dispatcher.BeginInvoke(System.Windows.Threading.DispatcherPriority.Loaded, () => Keyboard.Focus(FatalTitle));
        Announce.Alert(title + " " + body);
    }
}
