using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Shared;

namespace Solarljos.Views.Media;

/// <summary>
/// One photo or video at a time, as large as the window allows, with what is known of it
/// (openLightbox in src/gui/ui/app.js): its name, a box that selects it and Restore at the top,
/// the previous and the next of the grid either side, and below it which copy it is, its date,
/// size and where it was found, with the technical details under a line that opens them. Over the
/// program's window and modal to it; the arrow keys go to the previous and the next, Esc closes,
/// and the focus goes back to the tile of the copy shown last. A picture is drawn from the copy's
/// bytes in memory, a video played by Windows' media player from the engine's address of it.
/// </summary>
public sealed class Lightbox : Window
{
    static Tr T => Tr.Instance;

    readonly MediaGrid grid;
    readonly Session session;
    readonly ResourceDictionary look;
    readonly TextBlock heading = new() { FontSize = 17, FontWeight = FontWeights.Bold, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
    readonly Border frame = new() { CornerRadius = new CornerRadius(14), ClipToBounds = true };
    readonly StackPanel tools = new() { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
    readonly StackPanel facts = new();
    readonly ScrollViewer factsScroll;
    readonly Button prev;
    readonly Button next;
    readonly Button close;
    MediaElement? video;
    DispatcherTimer? clock;
    int seq;

    /// <summary>Which of the grid's copies it shows: its place in the grid's list.</summary>
    public int At { get; private set; }

    /// <summary>Whether what it shows has come: for the pictures of the window.</summary>
    public bool Ready { get; private set; }

    public Lightbox(Window owner, MediaGrid grid, Session session, ResourceDictionary look, int index)
    {
        this.grid = grid;
        this.session = session;
        this.look = look;
        Owner = owner;
        Resources.MergedDictionaries.Add(look);
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.Manual;
        FlowDirection = owner.FlowDirection;
        ShowActivated = owner.IsActive || owner.Left > -30000;
        SetResourceReference(BackgroundProperty, "Card");
        SetResourceReference(ForegroundProperty, "Text");
        SetResourceReference(FontFamilyProperty, "UiFont");
        FontSize = 15;
        UseLayoutRounding = true;
        SourceInitialized += (_, _) => Theme.TitleBar(this, round: true);
        Place(owner);

        // ---- its head: the name, Select and Restore, Close ----
        close = IconButton("close", T["common.close"], () => Close());
        close.IsCancel = true;
        AutomationProperties.SetHeadingLevel(heading, AutomationHeadingLevel.Level2);
        var head = new DockPanel { Margin = new Thickness(24, 12, 12, 12) };
        DockPanel.SetDock(close, Dock.Right);
        DockPanel.SetDock(tools, Dock.Right);
        head.Children.Add(close);
        head.Children.Add(tools);
        head.Children.Add(heading);
        tools.Margin = new Thickness(12, 0, 12, 0);

        // ---- the picture, between the previous and the next ----
        prev = IconButton("chevron", T["preview.prevItem"], () => Step(-1));
        if (prev.Content is Icon back) back.RenderTransform = new ScaleTransform(-1, 1, 10, 10);
        next = IconButton("chevron", T["preview.nextItem"], () => Step(1));
        foreach (var b in new[] { prev, next })
        {
            b.Width = 44;
            b.MinHeight = 72;
            b.VerticalAlignment = VerticalAlignment.Center;
        }
        frame.SetResourceReference(Border.BackgroundProperty, "Raised");
        var main = new Grid { Margin = new Thickness(12, 0, 12, 12) };
        main.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        main.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        main.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        frame.Margin = new Thickness(8, 0, 8, 0);
        Grid.SetColumn(frame, 1);
        Grid.SetColumn(next, 2);
        main.Children.Add(prev);
        main.Children.Add(frame);
        main.Children.Add(next);

        // ---- what is known of it ----
        factsScroll = new ScrollViewer { Content = facts, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Focusable = false, Padding = new Thickness(24, 12, 24, 16) };
        var factsBox = new Border { Child = factsScroll, BorderThickness = new Thickness(0, 1, 0, 0) };
        factsBox.SetResourceReference(Border.BorderBrushProperty, "Divider");
        SizeChanged += (_, _) => factsScroll.MaxHeight = Math.Max(120, ActualHeight * 0.36);

        var dock = new DockPanel();
        DockPanel.SetDock(head, Dock.Top);
        DockPanel.SetDock(factsBox, Dock.Bottom);
        dock.Children.Add(head);
        dock.Children.Add(factsBox);
        dock.Children.Add(main);
        var edge = new Border { Child = dock, BorderThickness = new Thickness(1) };
        edge.SetResourceReference(Border.BorderBrushProperty, "Divider");
        Content = edge;

        KeyDown += OnKeys;
        Loaded += (_, _) => Keyboard.Focus(close);
        Closed += (_, _) => StopVideo();
        At = index;
        _ = ShowAsync(index);
    }

    /// <summary>Over the program's window, 16 pixels in from each side of what it shows, as the page's dialog is.</summary>
    void Place(Window owner)
    {
        if (owner.Content is FrameworkElement area && PresentationSource.FromVisual(area) is { CompositionTarget: { } target })
        {
            var a = target.TransformFromDevice.Transform(area.PointToScreen(new Point(0, 0)));
            var b = target.TransformFromDevice.Transform(area.PointToScreen(new Point(area.ActualWidth, area.ActualHeight)));
            Left = Math.Min(a.X, b.X) + 16;
            Top = Math.Min(a.Y, b.Y) + 16;
            Width = Math.Max(320, Math.Abs(b.X - a.X) - 32);
            Height = Math.Max(320, Math.Abs(b.Y - a.Y) - 32);
            return;
        }
        Width = Math.Max(320, owner.ActualWidth - 32);
        Height = Math.Max(320, owner.ActualHeight - 32);
        Left = owner.Left + 16;
        Top = owner.Top + 16;
    }

    static Button IconButton(string glyph, string label, Action click)
    {
        var icon = new Icon { Glyph = glyph, Width = 20, Height = 20 };
        var b = new Button { Content = icon, Width = 40, Padding = new Thickness(0), ToolTip = label };
        b.SetResourceReference(StyleProperty, "Btn");
        AutomationProperties.SetName(b, label);
        b.Click += (_, _) => click();
        return b;
    }

    void Step(int by)
    {
        int i = At + by;
        if (i < 0 || i >= grid.List.Count) return;
        _ = ShowAsync(i);
    }

    void OnKeys(object sender, KeyEventArgs e)
    {
        // Not while a box, the player or a line that opens has the keys: they use the arrows themselves.
        if (e.OriginalSource is CheckBox or Slider or ToggleButton or MediaElement) return;
        var key = e.Key;
        if (FlowDirection == FlowDirection.RightToLeft && key is Key.Left or Key.Right) key = key == Key.Left ? Key.Right : Key.Left;
        if (key == Key.Right) Step(1);
        else if (key == Key.Left) Step(-1);
        else return;
        e.Handled = true;
    }

    // ---- one copy --------------------------------------------------------------------------------

    async Task ShowAsync(int i)
    {
        var list = grid.List;
        if (i < 0 || i >= list.Count) return;
        At = i;
        Ready = false;
        int mine = ++seq;
        var it = list[i];
        var uid = it.Uid;
        var name = it.Name is { Length: > 0 } n ? n : MediaData.TileLabel(it);
        heading.Text = name;
        Title = name;
        StopVideo();
        frame.Child = Centered(Build.Text(T["preview.loading"], "Muted"));
        Tools(it);
        Facts(it);
        prev.IsEnabled = i > 0;
        next.IsEnabled = i < list.Count - 1;
        grid.ShowMoreIfNear(i);

        JsonElement a;
        try
        {
            a = await session.Client.AboutAsync(uid);
        }
        catch (Exception e) when (e is CoreException or HttpRequestException or TaskCanceledException)
        {
            if (mine != seq) return;
            var said = e is CoreException { Status: 410 } ? T["empty.noLongerThere"] : Formats.ErrorText(e);
            frame.Child = Centered(Build.Callout("error", null, Build.Text(said)).Margin(16, 16, 16, 16));
            Ready = true;
            return;
        }
        if (mine != seq) return;
        var preview = Str(a, "preview");
        var ext = Str(a, "ext");
        if (preview == "video")
        {
            ShowVideo(it, uid, ext);
            Ready = true;
            return;
        }
        if (preview != "image")
        {
            frame.Child = Cannot(it, ext);
            Ready = true;
            return;
        }
        try
        {
            var bytes = await session.Client.GetBytesAsync($"/api/copy/{Uri.EscapeDataString(uid)}");
            var picture = await Task.Run(() => Thumbs.Decode(bytes, 0, 4096));
            if (mine != seq) return;
            // Never larger than it is: a small picture stays small, as the page's does.
            var img = new Image
            {
                Source = picture, Stretch = Stretch.Uniform, MaxWidth = picture.PixelWidth, MaxHeight = picture.PixelHeight,
                HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
            };
            RenderOptions.SetBitmapScalingMode(img, BitmapScalingMode.HighQuality);
            AutomationProperties.SetName(img, MediaData.TileLabel(it));
            frame.Child = img;
        }
        catch (Exception e) when (e is CoreException or HttpRequestException or TaskCanceledException)
        {
            if (mine != seq) return;
            var said = e is CoreException { Status: 410 } ? T["empty.noLongerThere"] : Formats.ErrorText(e);
            frame.Child = Centered(Build.Callout("error", null, Build.Text(said)).Margin(16, 16, 16, 16));
        }
        catch (Exception e) when (e is NotSupportedException or FileFormatException or IOException or ArgumentException or InvalidOperationException
            or System.Runtime.InteropServices.COMException)
        {
            if (mine != seq) return;
            frame.Child = Cannot(it, ext);
        }
        Ready = true;
    }

    static FrameworkElement Centered(FrameworkElement e)
    {
        e.HorizontalAlignment = HorizontalAlignment.Center;
        e.VerticalAlignment = VerticalAlignment.Center;
        return e;
    }

    /// <summary>What Windows cannot show or play here, with its format: restored, it opens in an app that can.</summary>
    static FrameworkElement Cannot(Copy it, string? ext)
    {
        var key = MediaData.IsVideo(it) ? "desktop.media.videoCannot" : "desktop.media.imageCannot";
        var said = Tr.Instance.Get(key, ("format", Formats.FormatName(ext ?? it.Ext)));
        return Centered(Build.Callout("info", null, Build.Text(said)).Margin(16, 16, 16, 16));
    }

    static string? Str(JsonElement o, string k) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    void Tools(Copy it)
    {
        tools.Children.Clear();
        var sel = Build.Check(T["grid.select"], grid.IsSelected(it.Uid));
        sel.VerticalAlignment = VerticalAlignment.Center;
        sel.Margin = new Thickness(0, 0, 12, 0);
        sel.Checked += (_, _) => Pick(it, true);
        sel.Unchecked += (_, _) => Pick(it, false);
        tools.Children.Add(sel);
        if (it.Tier != "gone")
        {
            var restore = Build.Button(T["results.restore"], () => Restore(it));
            restore.MinHeight = 32;
            restore.Padding = new Thickness(12, 4, 12, 4);
            restore.FontSize = 14;
            Look.SetRadius(restore, new CornerRadius(8));
            tools.Children.Add(restore);
        }
    }

    void Pick(Copy it, bool on)
    {
        grid.SetSelected(it.Uid, on);
        grid.UpdateBar(true);
    }

    void Restore(Copy it)
    {
        var dlg = new RestoreDialog(this, session, [it]);
        if (grid.ForShot) dlg.Show();
        else dlg.ShowDialog();
    }

    void Facts(Copy it)
    {
        facts.Children.Clear();
        var meta = Build.Text(MediaData.MetaLine(it), "Muted");
        meta.VerticalAlignment = VerticalAlignment.Center;
        meta.Margin = new Thickness(12, 0, 0, 0);
        var badges = new WrapPanel();
        badges.Children.Add(Build.TierBadge(it));
        badges.Children.Add(meta);
        facts.Children.Add(badges.Margin(0, 0, 0, 4));
        facts.Children.Add(Build.Text(Formats.TierHelp(it), "Hint").Margin(0, 0, 0, 4));
        var found = Build.Text("", "Body");
        found.Inlines.Add(new System.Windows.Documents.Run(T["preview.info.foundIn"] + ": ") { Foreground = (Brush)FindResource("Text2") });
        found.Inlines.Add(new System.Windows.Documents.Run(MediaData.FoundIn(it)) { FontWeight = FontWeights.SemiBold });
        facts.Children.Add(found.Margin(0, 0, 0, 4));
        var details = new Expander { Header = T["preview.technical"], Content = InfoList(it), Style = (Style)look["MediaDisclosure"] };
        AutomationProperties.SetName(details, T["preview.technical"]);
        facts.Children.Add(details);
    }

    /// <summary>Everything known about a copy, as terms and what they are (infoList).</summary>
    static Grid InfoList(Copy c)
    {
        var g = new Grid();
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto, MinWidth = 112 });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        void row(string key, params FrameworkElement?[] value)
        {
            var parts = value.OfType<FrameworkElement>().ToList();
            if (parts.Count == 0) return;
            int at = g.RowDefinitions.Count;
            g.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var term = Build.Text(Tr.Instance[key], "Muted").Margin(0, at > 0 ? 8 : 0, 16, 0);
            Grid.SetRow(term, at);
            g.Children.Add(term);
            var dd = Build.Stack(parts.ToArray());
            dd.Margin = new Thickness(0, at > 0 ? 8 : 0, 0, 0);
            Grid.SetRow(dd, at);
            Grid.SetColumn(dd, 1);
            g.Children.Add(dd);
        }
        TextBlock words(string? s, string style = "Body") => Build.Text(s ?? "", style);
        TextBlock? maybe(string? s, string style = "Body") => string.IsNullOrEmpty(s) ? null : words(s, style);
        TextBlock path(string p)
        {
            var t = words(p);
            t.FlowDirection = FlowDirection.LeftToRight;
            t.HorizontalAlignment = HorizontalAlignment.Left;
            return t;
        }
        var T = Tr.Instance;
        var name = c.Name;
        row("preview.info.path", c.Path is { Length: > 0 } p ? path(p) : words(name is { Length: > 0 } ? T.Get("results.nameOnly", ("name", name)) : T["results.nameUnknown"]));
        row("preview.info.when", words(Formats.TimeText(c)));
        if (!c.IsDir) row("preview.info.size", words(Formats.Size(c.Size)));
        if (c.Width is > 0 && c.Height is > 0) row("preview.info.dimensions", words(T.Get("fmt.dimensions", ("w", c.Width), ("h", c.Height))));
        var badge = Build.TierBadge(c);
        badge.HorizontalAlignment = HorizontalAlignment.Left;
        row("preview.info.quality", badge, words(Formats.TierHelp(c)).Margin(0, 2, 0, 0));
        row("preview.info.state", words(Formats.StateText(c.State)), words(Formats.StateHelp(c.State), "Muted").Margin(0, 2, 0, 0));
        row("preview.info.foundIn", words(Formats.KindLabel(c.Kind, c.KindLabel)),
            words(Formats.KindHelp(c.Kind, Formats.SourceLabel(c.Source, c.Source)), "Muted").Margin(0, 2, 0, 0));
        var seen = MediaData.RawList(c, "seen").Where((k) => k != c.Kind).ToList();
        if (seen.Count > 0) row("preview.info.alsoIn", words(Formats.List(seen.Select((k) => Formats.KindLabel(k)))));
        row("preview.info.keptAt", c.Origin is { Length: > 0 } o ? path(o) : null);
        row("preview.info.note", maybe(c.Note));
        var id = words(MediaData.RawString(c, "id") ?? c.Uid[..Math.Min(8, c.Uid.Length)]);
        id.FontFamily = new FontFamily("Cascadia Mono, Consolas, Segoe UI");
        id.FontSize = 13;
        id.FlowDirection = FlowDirection.LeftToRight;
        id.HorizontalAlignment = HorizontalAlignment.Left;
        row("preview.info.id", id, words(T["preview.info.idHint"], "Muted").Margin(0, 2, 0, 0));
        return g;
    }

    // ---- a video -----------------------------------------------------------------------------------

    /// <summary>
    /// A player for a copy, its first frame shown until it is played: Play and Pause, where it is
    /// and how long it lasts, and a bar to move through it. Windows plays what it can; what it
    /// cannot says so.
    /// </summary>
    void ShowVideo(Copy it, string uid, string? ext)
    {
        var media = new MediaElement
        {
            LoadedBehavior = MediaState.Manual, UnloadedBehavior = MediaState.Close, ScrubbingEnabled = true, Stretch = Stretch.Uniform,
            HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
        };
        AutomationProperties.SetName(media, MediaData.TileLabel(it));
        video = media;
        var playing = false;
        var toggle = new Button { Width = 40, Padding = new Thickness(0) };
        toggle.SetResourceReference(StyleProperty, "Btn");
        var time = Build.Text("0:00", "Muted");
        time.VerticalAlignment = VerticalAlignment.Center;
        time.Margin = new Thickness(12, 0, 12, 0);
        time.FlowDirection = FlowDirection.LeftToRight;
        time.FontFeatures();
        var seek = new Slider { Minimum = 0, Maximum = 1, VerticalAlignment = VerticalAlignment.Center, IsMoveToPointEnabled = true, Style = (Style)look["MediaSeek"] };
        AutomationProperties.SetName(seek, T["desktop.media.position"]);
        bool dragging = false, setting = false;
        void showToggle()
        {
            toggle.Content = PlayGlyph(playing);
            var label = T[playing ? "desktop.media.pause" : "desktop.media.play"];
            AutomationProperties.SetName(toggle, label);
            toggle.ToolTip = label;
        }
        string fmt(TimeSpan t) => t.TotalHours >= 1 ? t.ToString(@"h\:mm\:ss") : t.ToString(@"m\:ss");
        void tick()
        {
            // A video that does not say how long it is -- a WebM a browser recorded -- shows where it is alone.
            bool known = media.NaturalDuration.HasTimeSpan;
            seek.IsEnabled = known;
            if (!known)
            {
                time.Text = fmt(media.Position);
                return;
            }
            var length = media.NaturalDuration.TimeSpan;
            time.Text = fmt(media.Position) + " / " + fmt(length);
            if (dragging) return;
            setting = true;
            seek.Maximum = Math.Max(0.1, length.TotalSeconds);
            seek.Value = media.Position.TotalSeconds;
            setting = false;
        }
        showToggle();
        toggle.Click += (_, _) =>
        {
            if (playing) media.Pause();
            else media.Play();
            playing = !playing;
            showToggle();
        };
        seek.ValueChanged += (_, _) =>
        {
            if (!setting) media.Position = TimeSpan.FromSeconds(seek.Value);
        };
        seek.AddHandler(Thumb.DragStartedEvent, new DragStartedEventHandler((_, _) => dragging = true));
        seek.AddHandler(Thumb.DragCompletedEvent, new DragCompletedEventHandler((_, _) => dragging = false));
        clock = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        clock.Tick += (_, _) => tick();
        media.MediaOpened += (_, _) =>
        {
            // Never larger than it is, as the page's player.
            if (media.NaturalVideoWidth > 0) media.MaxWidth = media.NaturalVideoWidth;
            if (media.NaturalVideoHeight > 0) media.MaxHeight = media.NaturalVideoHeight;
            tick();
            clock.Start();
        };
        media.MediaEnded += (_, _) =>
        {
            playing = false;
            media.Pause();
            media.Position = TimeSpan.Zero;
            showToggle();
            tick();
        };
        media.MediaFailed += (_, _) =>
        {
            StopVideo();
            frame.Child = Cannot(it, ext);
        };
        // A video runs left to right in every language, as a browser's player does.
        var controls = new DockPanel { Margin = new Thickness(12, 8, 12, 12), FlowDirection = FlowDirection.LeftToRight };
        DockPanel.SetDock(toggle, Dock.Left);
        DockPanel.SetDock(time, Dock.Left);
        controls.Children.Add(toggle);
        controls.Children.Add(time);
        controls.Children.Add(seek);
        var player = new DockPanel();
        DockPanel.SetDock(controls, Dock.Bottom);
        player.Children.Add(controls);
        player.Children.Add(media);
        frame.Child = player;
        media.Source = session.Client.CopyUri(uid);
        // Opened and stopped at its start: its first frame shows, and nothing plays until asked.
        media.Pause();
    }

    /// <summary>The play mark, or the two bars of pause.</summary>
    static FrameworkElement PlayGlyph(bool playing)
    {
        if (!playing) return new Icon { Glyph = "play", Filled = true, Width = 18, Height = 18, FlowDirection = FlowDirection.LeftToRight };
        var bars = new Canvas { Width = 18, Height = 18 };
        foreach (var x in new[] { 4.0, 10.5 })
        {
            var r = new Rectangle { Width = 3.5, Height = 12, RadiusX = 1, RadiusY = 1 };
            r.SetResourceReference(Shape.FillProperty, "Text");
            Canvas.SetLeft(r, x);
            Canvas.SetTop(r, 3);
            bars.Children.Add(r);
        }
        return bars;
    }

    void StopVideo()
    {
        clock?.Stop();
        clock = null;
        if (video is { } v)
        {
            v.Stop();
            v.Close();
            v.Source = null;
        }
        video = null;
    }
}
