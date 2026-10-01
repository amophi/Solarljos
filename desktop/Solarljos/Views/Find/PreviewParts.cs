using System.IO;
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

namespace Solarljos.Views.Find;

/// <summary>
/// The tabs of a preview, each a way to look at a copy (picturePanel, videoPanel, textPanel,
/// hexPanel and infoList in app.js). Nothing of a copy is ever written anywhere: a picture is
/// decoded from the bytes in memory, a video is played from the engine's address for it, and
/// nothing can be dragged out of the window, so that the only way a copy leaves is Restore.
/// </summary>
public static class PreviewParts
{
    static Tr T => Tr.Instance;

    public interface IPart
    {
        FrameworkElement El { get; }
        void Pause() { }
        void Destroy() { }
    }

    /// <summary>A button that shows only an icon, named for assistive technology and in its tooltip.</summary>
    public static Button IconButton(string glyph, string label, Action onClick, double size = 32)
    {
        var b = Build.Button("", onClick, "BtnQuiet");
        b.Content = new Ui.Icon { Glyph = glyph, Width = 20, Height = 20 };
        b.Padding = new Thickness(0);
        b.Width = b.Height = b.MinWidth = b.MinHeight = size;
        Look.SetRadius(b, new CornerRadius(8));
        b.ToolTip = label;
        AutomationProperties.SetName(b, label);
        return b;
    }

    static Border Frame(UIElement child)
    {
        var f = new Border { Child = child, Padding = new Thickness(8), CornerRadius = new CornerRadius(14) };
        f.SetResourceReference(Border.BackgroundProperty, "Raised");
        return f;
    }

    /// <summary>Six tenths of the window's height, as the page's 60vh.</summary>
    static double Tall(Window? w) => Math.Max(240, (w?.ActualHeight ?? 800) * 0.6);

    // ---- what the name says, and what the bytes are ------------------------------------------

    // The formats whose first bytes sniff() always recognises, by what they are and, for those
    // several names stand for, which: for these a name that disagrees with the bytes, or bytes
    // that are nothing known, say something about the copy.
    static readonly Dictionary<string, (string Media, string? Family)> WellKnown = new()
    {
        [".jpg"] = ("image", "jpg"), [".jpeg"] = ("image", "jpg"), [".png"] = ("image", null), [".gif"] = ("image", null),
        [".bmp"] = ("image", null), [".webp"] = ("image", null), [".heic"] = ("image", "heic"), [".heif"] = ("image", "heic"),
        [".avif"] = ("image", null), [".tif"] = ("image", "tif"), [".tiff"] = ("image", "tif"), [".mp4"] = ("video", "mp4"),
        [".m4v"] = ("video", "mp4"), [".mov"] = ("video", "mp4"), [".3gp"] = ("video", "mp4"), [".avi"] = ("video", null),
        [".mkv"] = ("video", "mkv"), [".webm"] = ("video", "mkv"), [".mp3"] = ("audio", null), [".wav"] = ("audio", null),
        [".flac"] = ("audio", null), [".m4a"] = ("audio", "mp4"),
    };

    static string FamilyOf(string ext) => WellKnown.TryGetValue(ext, out var w) ? w.Family ?? ext : ext;

    /// <summary>
    /// What to say when a copy's name and its bytes disagree: a ".jpg" that holds a PDF or a PNG,
    /// or bytes in no format known. Not for a smaller copy, whose own format is not its file's.
    /// </summary>
    public static string? Mismatch(Copy copy, About a)
    {
        var name = copy.Name;
        var ext = Paths.ExtOf(name ?? "");
        if (name is null || !WellKnown.TryGetValue(ext, out var known) || copy.Tier == "derived") return null;
        if (a.MediaType is null) return T.Get("preview.unknownContent", ("ext", ext));
        var isExt = (a.Ext ?? "").ToLowerInvariant();
        if (a.MediaType != known.Media || (isExt.Length > 0 && FamilyOf(isExt) != FamilyOf(ext)))
            return T.Get("preview.extMismatch", ("ext", ext), ("format", Formats.FormatName(a.Ext ?? a.MediaType)));
        return null;
    }

    // ---- a picture ----------------------------------------------------------------------------

    /// <summary>
    /// A picture, from its bytes, decoded in memory by Windows' own decoders and turned as its Exif
    /// says; one they cannot read is said so. No thumbnail of it is ever asked of Windows: those are
    /// kept in the very cache a search for photos reads.
    /// </summary>
    public sealed class Picture : IPart
    {
        public FrameworkElement El { get; }
        readonly Image image = new() { Stretch = Stretch.Uniform, StretchDirection = StretchDirection.DownOnly, AllowDrop = false };
        readonly StackPanel box;
        readonly CancellationTokenSource cancel = new();

        public Picture(Session session, Copy copy, About a, Func<Window?> window)
        {
            var alt = T.Get("preview.imageAlt", ("name", copy.Name ?? T["results.nameUnknown"]));
            AutomationProperties.SetName(image, alt);
            var loading = Build.Text(T["preview.loading"], "Muted");
            var frame = Frame(new Grid { Children = { loading, image } });
            box = Build.Stack(frame);
            if (copy.Width is { } w && copy.Height is { } h && w > 0 && h > 0)
                box.Children.Add(Build.Text(T.Get("fmt.dimensions", ("w", w), ("h", h)), "Muted").Margin(0, 8, 0, 0));
            El = box;
            frame.Loaded += (_, _) => image.MaxHeight = Tall(window());
            _ = LoadAsync(session, copy, a, frame, loading);
        }

        async Task LoadAsync(Session session, Copy copy, About a, Border frame, TextBlock loading)
        {
            try
            {
                var bytes = await session.Client.GetBytesAsync($"/api/copy/{Uri.EscapeDataString(copy.Uid)}", cancel.Token);
                var picture = await Task.Run(() => Decode(bytes), cancel.Token);
                cancel.Token.ThrowIfCancellationRequested();
                loading.Visibility = Visibility.Collapsed;
                image.Source = picture;
            }
            catch (OperationCanceledException) when (cancel.IsCancellationRequested)
            {
                // Closed meanwhile.
            }
            catch (Exception e) when (Arrangement.IsTrouble(e))
            {
                frame.Visibility = Visibility.Collapsed;
                box.Children.Insert(0, Build.Callout("error", null, Build.Text(Formats.ErrorText(e), "Body")));
            }
            catch (Exception e) when (e is NotSupportedException or FileFormatException or InvalidOperationException or ArgumentException
                or OverflowException or IOException or System.Runtime.InteropServices.COMException)
            {
                // Windows has no decoder for it (HEIC, AVIF without their extensions), or it is damaged:
                // said as the photos' own view says it, restored it opens in an app that can.
                frame.Visibility = Visibility.Collapsed;
                var said = T.Get("desktop.imageCannot", ("format", Formats.FormatName(a.Ext ?? copy.Ext)));
                box.Children.Insert(0, Build.Callout("info", null, Build.Text(said, "Body")));
            }
        }

        const int Largest = 2400;

        /// <summary>The picture, at most 2,400 pixels across, turned upright as its Exif orientation says.</summary>
        static BitmapSource Decode(byte[] bytes)
        {
            int orientation = 1, width = 0, height = 0;
            using (var probe = new MemoryStream(bytes, false))
            {
                var decoder = BitmapDecoder.Create(probe, BitmapCreateOptions.DelayCreation | BitmapCreateOptions.IgnoreColorProfile, BitmapCacheOption.None);
                var first = decoder.Frames[0];
                width = first.PixelWidth;
                height = first.PixelHeight;
                try
                {
                    if (first.Metadata is BitmapMetadata md && md.GetQuery("System.Photo.Orientation") is ushort o) orientation = o;
                }
                catch (Exception e) when (e is NotSupportedException or InvalidOperationException or ArgumentException or System.Runtime.InteropServices.COMException)
                {
                }
            }
            var bmp = new BitmapImage();
            using (var stream = new MemoryStream(bytes, false))
            {
                bmp.BeginInit();
                bmp.CacheOption = BitmapCacheOption.OnLoad;
                bmp.CreateOptions = BitmapCreateOptions.IgnoreColorProfile;
                bmp.StreamSource = stream;
                // A large photo is decoded at the size it can be seen at, not whole.
                if (width >= height && width > Largest) bmp.DecodePixelWidth = Largest;
                else if (height > width && height > Largest) bmp.DecodePixelHeight = Largest;
                bmp.EndInit();
            }
            BitmapSource source = bmp;
            Transform? turn = orientation switch
            {
                2 => new ScaleTransform(-1, 1),
                3 => new RotateTransform(180),
                4 => new ScaleTransform(1, -1),
                5 => new TransformGroup { Children = { new ScaleTransform(-1, 1), new RotateTransform(270) } },
                6 => new RotateTransform(90),
                7 => new TransformGroup { Children = { new ScaleTransform(-1, 1), new RotateTransform(90) } },
                8 => new RotateTransform(270),
                _ => null,
            };
            if (turn is not null) source = new TransformedBitmap(source, turn);
            source.Freeze();
            return source;
        }

        public void Destroy() => cancel.Cancel();
    }

    // ---- a video ------------------------------------------------------------------------------

    /// <summary>
    /// A video, played by Windows' media player from the engine's address for it, which asks for
    /// it a range at a time; with a button to play and pause it and a line to move through it.
    /// One the player cannot play is said so.
    /// </summary>
    public sealed class Video : IPart
    {
        public FrameworkElement El { get; }
        readonly MediaElement media;
        readonly Button play;
        readonly Slider where = new() { Minimum = 0, Maximum = 1, SmallChange = 5, LargeChange = 30 };
        readonly TextBlock time = Build.Text("", "Muted");
        readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromMilliseconds(250) };
        bool playing;
        bool moving;

        public Video(Session session, Copy copy, About a)
        {
            media = new MediaElement
            {
                LoadedBehavior = MediaState.Manual, UnloadedBehavior = MediaState.Manual, ScrubbingEnabled = true,
                Stretch = Stretch.Uniform, MaxHeight = 420, AllowDrop = false,
            };
            AutomationProperties.SetName(media, copy.Name ?? T["results.nameUnknown"]);
            play = IconButton("play", T["desktop.video.play"], Toggle, 40);
            play.IsEnabled = false;
            where.SetResourceReference(FrameworkElement.StyleProperty, "FindSlider");
            where.IsEnabled = false;
            AutomationProperties.SetName(where, T["desktop.video.position"]);
            where.ValueChanged += (_, _) =>
            {
                if (moving) return;
                media.Position = TimeSpan.FromSeconds(where.Value);
                ShowTime();
            };
            var controls = new DockPanel { Margin = new Thickness(0, 8, 0, 0) };
            DockPanel.SetDock(play, Dock.Left);
            DockPanel.SetDock(time, Dock.Right);
            time.FlowDirection = FlowDirection.LeftToRight;
            time.VerticalAlignment = VerticalAlignment.Center;
            time.Margin = new Thickness(12, 0, 4, 0);
            where.Margin = new Thickness(12, 0, 0, 0);
            controls.Children.Add(play);
            controls.Children.Add(time);
            controls.Children.Add(where);
            var frame = Frame(media);
            var msg = new StackPanel { Visibility = Visibility.Collapsed };
            El = Build.Stack(frame, controls, msg);
            media.MediaOpened += (_, _) =>
            {
                play.IsEnabled = true;
                if (media.NaturalDuration.HasTimeSpan)
                {
                    where.Maximum = Math.Max(0.1, media.NaturalDuration.TimeSpan.TotalSeconds);
                    where.IsEnabled = true;
                }
                ShowTime();
            };
            media.MediaEnded += (_, _) =>
            {
                Stop();
                media.Position = TimeSpan.Zero;
                Sync();
            };
            media.MediaFailed += (_, _) =>
            {
                Stop();
                frame.Visibility = Visibility.Collapsed;
                controls.Visibility = Visibility.Collapsed;
                var said = T.Get("desktop.videoCannot", ("format", Formats.FormatName(a.Ext ?? copy.Ext)));
                msg.Children.Add(Build.Callout("info", null, Build.Text(said, "Body")));
                msg.Visibility = Visibility.Visible;
            };
            timer.Tick += (_, _) => Sync();
            media.Source = session.Client.CopyUri(copy.Uid);
            // Paused at its start once it is in the window, so that its first picture shows.
            media.Loaded += (_, _) =>
            {
                if (started) return;
                started = true;
                media.Pause();
            };
            ShowTime();
        }

        bool started;

        void Toggle()
        {
            if (playing)
            {
                Pause();
                return;
            }
            media.Play();
            playing = true;
            timer.Start();
            SetButton();
        }

        void Stop()
        {
            playing = false;
            timer.Stop();
            SetButton();
        }

        void SetButton()
        {
            var label = T[playing ? "desktop.video.pause" : "desktop.video.play"];
            AutomationProperties.SetName(play, label);
            play.ToolTip = label;
            play.Content = playing ? PauseGlyph() : new Ui.Icon { Glyph = "play", Width = 20, Height = 20 };
        }

        /// <summary>Two bars, drawn as the page's icons are: the page has no icon for a pause.</summary>
        static UIElement PauseGlyph()
        {
            var p = new System.Windows.Shapes.Path { Data = Geometry.Parse("M9 6.5v11 M15 6.5v11"), StrokeThickness = 1.7, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, Width = 24, Height = 24 };
            p.SetResourceReference(Shape.StrokeProperty, "Text");
            return new Viewbox { Child = p, Width = 20, Height = 20 };
        }

        void Sync()
        {
            moving = true;
            where.Value = Math.Min(where.Maximum, media.Position.TotalSeconds);
            moving = false;
            ShowTime();
        }

        static string Clock(TimeSpan t) => t.TotalHours >= 1 ? t.ToString(@"h\:mm\:ss") : t.ToString(@"m\:ss");

        void ShowTime()
        {
            var total = media.NaturalDuration.HasTimeSpan ? media.NaturalDuration.TimeSpan : (TimeSpan?)null;
            time.Text = total is { } d ? $"{Clock(media.Position)} / {Clock(d)}" : Clock(media.Position);
        }

        public void Pause()
        {
            if (!playing) return;
            media.Pause();
            Stop();
        }

        public void Destroy()
        {
            timer.Stop();
            media.Stop();
            media.Close();
            media.Source = null;
        }
    }

    // ---- text ---------------------------------------------------------------------------------

    public const int TextMax = 256 * 1024;

    /// <summary>A copy's text: its first 256 KB, decoded here in the encoding chosen, never run or parsed.</summary>
    public sealed class TextPart : IPart
    {
        public FrameworkElement El { get; }
        readonly TextBox view = new();
        readonly StackPanel notes = new();
        readonly About a;
        readonly ComboBox select;
        readonly Build.SwitchRow wrap;
        readonly CancellationTokenSource cancel = new();
        byte[]? bytes;
        string encoding = "auto";

        internal void Set(string? enc, bool wrapped)
        {
            if (enc is not null) select.SelectedValue = enc;
            if (wrapped) wrap.IsOn = true;
        }

        public TextPart(Session session, Copy copy, About a, byte[] head, Func<Window?> window)
        {
            this.a = a;
            view.SetResourceReference(FrameworkElement.StyleProperty, "FindTextView");
            Put(T["preview.loading"]);
            AutomationProperties.SetName(view, copy.Name ?? T["preview.tab.text"]);
            view.Loaded += (_, _) => view.MaxHeight = Tall(window());
            view.AllowDrop = false;
            // Its words can be copied, never dragged out: dropped in a folder, a drag can become a file.
            DataObject.AddCopyingHandler(view, (_, e) =>
            {
                if (e.IsDragDrop) e.CancelCommand();
            });
            var choices = Bytes.Encodings.Select((e) => (e.Value, T[e.Key])).ToList();
            select = Build.Select(choices, "auto", T["preview.encoding.label"]);
            select.MinWidth = 200;
            select.SetResourceReference(Control.BackgroundProperty, "Card");
            select.SelectionChanged += (_, _) =>
            {
                encoding = select.SelectedValue as string ?? "auto";
                if (bytes is not null) Show();
            };
            var label = Build.Text(T["preview.encoding.label"], "Body");
            label.FontWeight = FontWeights.Bold;
            label.VerticalAlignment = VerticalAlignment.Center;
            label.Margin = new Thickness(0, 0, 12, 0);
            wrap = Build.Switch(T["preview.wrap"], false, null, compact: true);
            wrap.Changed += () => view.TextWrapping = wrap.IsOn ? TextWrapping.Wrap : TextWrapping.NoWrap;
            var tools = new WrapPanel { Margin = new Thickness(0, 0, 0, 8) };
            tools.Children.Add(Build.Stack(Orientation.Horizontal, label, select).Margin(0, 0, 16, 8));
            tools.Children.Add(wrap.El.Margin(0, 0, 0, 8));
            El = Build.Stack(tools, notes, view.Margin(0, 8, 0, 0));
            _ = LoadAsync(session, copy, head);
        }

        async Task LoadAsync(Session session, Copy copy, byte[] head)
        {
            try
            {
                bytes = a.Size is { } size && size <= head.Length ? head : await session.Client.ReadBytesAsync(copy.Uid, 0, TextMax, cancel.Token);
                cancel.Token.ThrowIfCancellationRequested();
                Show();
            }
            catch (OperationCanceledException) when (cancel.IsCancellationRequested)
            {
                // Closed meanwhile.
            }
            catch (Exception e) when (Arrangement.IsTrouble(e))
            {
                Put("");
                notes.Children.Add(Build.Callout("error", null, Build.Text(Formats.ErrorText(e), "Body")));
            }
        }

        void Show()
        {
            var b = bytes!;
            bool cut = a.Size is null ? b.Length >= TextMax : b.Length < a.Size;
            var d = Bytes.DecodeText(b, encoding, cut);
            Put(d.Text);
            notes.Children.Clear();
            var key = Bytes.Encodings.FirstOrDefault((e) => e.Value == d.Encoding).Key;
            var lines = new List<string> { T.Get("preview.encoding", ("encoding", key is null ? d.Encoding : T[key])) };
            if (cut) lines.Add(T.Get("preview.textTruncated", ("shown", Formats.Size(b.Length)), ("size", Formats.Size(a.Size))));
            if (a.Ext == ".svg") lines.Add(T["preview.svgAsText"]);
            notes.Children.Add(Build.Text(string.Join(" · ", lines), "Muted"));
        }

        /// <summary>
        /// The words in the box, laid out in the direction their first letter has, as the page's
        /// unicode-bidi: plaintext lays out each of its lines: Hebrew or Arabic from the right.
        /// </summary>
        void Put(string text)
        {
            view.Text = text;
            view.FlowDirection = DirectionOf(text);
        }

        public void Destroy() => cancel.Cancel();
    }

    /// <summary>
    /// The direction a text is written in, from its first letter that has one: right to left for
    /// Hebrew, Arabic and the scripts written as they are, else left to right. Digits, marks and
    /// punctuation have none of their own, and are passed over.
    /// </summary>
    static FlowDirection DirectionOf(string text)
    {
        foreach (var r in text.EnumerateRunes())
        {
            int v = r.Value;
            // The marks that are there only to say which: right to left, and the Arabic letter mark; left to right.
            if (v is 0x200F or 0x061C) return FlowDirection.RightToLeft;
            if (v == 0x200E) return FlowDirection.LeftToRight;
            if (!System.Text.Rune.IsLetter(r)) continue;
            bool rtl = v is >= 0x0590 and <= 0x08FF or >= 0xFB1D and <= 0xFDFF or >= 0xFE70 and <= 0xFEFF
                or >= 0x10800 and <= 0x10FFF or >= 0x1E800 and <= 0x1EFFF;
            return rtl ? FlowDirection.RightToLeft : FlowDirection.LeftToRight;
        }
        return FlowDirection.LeftToRight;
    }

    // ---- the bytes ----------------------------------------------------------------------------

    /// <summary>The bytes, a page at a time: first a sentence on what they start with, then the table.</summary>
    public sealed class Hex : IPart
    {
        public FrameworkElement El { get; }
        readonly Session session;
        readonly Copy copy;
        readonly long? size;
        readonly ScrollViewer tableBox = new() { HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, IsTabStop = true };
        readonly TextBlock page = Build.Text("", "Muted");
        readonly Button prev, next;
        readonly CancellationTokenSource cancel = new();
        long offset;

        public Hex(Session session, Copy copy, About a, byte[] head)
        {
            this.session = session;
            this.copy = copy;
            size = a.Size;
            var magic = Bytes.MagicOf(head);
            var summary = Build.Text(a.Ext is not null
                ? T.Get("preview.hexSummary", ("magic", magic), ("format", Formats.FormatName(a.Ext)))
                : T.Get("preview.hexUnknown", ("magic", magic)), "Body");
            prev = Small(T["preview.hexPrev"], async () => await TurnAsync(-1));
            next = Small(T["preview.hexNext"], async () => await TurnAsync(1));
            page.VerticalAlignment = VerticalAlignment.Center;
            page.Margin = new Thickness(0, 0, 8, 8);
            AutomationProperties.SetLiveSetting(page, AutomationLiveSetting.Polite);
            var actions = new WrapPanel { Margin = new Thickness(0, 12, 0, 0) };
            actions.Children.Add(prev.Margin(0, 0, 8, 8));
            actions.Children.Add(page);
            actions.Children.Add(next.Margin(0, 0, 8, 8));
            tableBox.Margin = new Thickness(0, 8, 0, 0);
            // The bytes read left to right in any language, and so does their scroller, which starts at the offsets.
            tableBox.FlowDirection = FlowDirection.LeftToRight;
            Table.Sideways(tableBox);
            // The table is mostly wider than the pane: the keyboard stops at it, for Left and Right to
            // move it sideways to the text; Up and Down, and the pages, go on to the preview it is in.
            tableBox.SetResourceReference(FrameworkElement.FocusVisualStyleProperty, "FindInsetFocus");
            AutomationProperties.SetName(tableBox, T["preview.hex.caption"]);
            tableBox.PreviewKeyDown += (_, e) =>
            {
                if (e.OriginalSource != tableBox || Keyboard.Modifiers != ModifierKeys.None || Outer(tableBox) is not { } outer) return;
                Action? move = e.Key switch
                {
                    Key.Up => outer.LineUp, Key.Down => outer.LineDown, Key.PageUp => outer.PageUp, Key.PageDown => outer.PageDown, _ => null,
                };
                if (move is null) return;
                e.Handled = true;
                move();
            };
            El = Build.Stack(summary, tableBox, actions);
            Render(head, 0);
        }

        /// <summary>The scroller around it that goes up and down.</summary>
        static ScrollViewer? Outer(DependencyObject d)
        {
            for (var at = VisualTreeHelper.GetParent(d); at is not null; at = VisualTreeHelper.GetParent(at))
                if (at is ScrollViewer sv) return sv;
            return null;
        }

        static Button Small(string text, Action click)
        {
            var b = Build.Button(text, click);
            b.MinHeight = 32;
            b.Padding = new Thickness(12, 4, 12, 4);
            b.FontSize = 14;
            Look.SetRadius(b, new CornerRadius(8));
            return b;
        }

        void Render(byte[] bytes, long at)
        {
            offset = at;
            var table = new Table(new TableColumn(), new TableColumn(), new TableColumn()) { PadX = 8, PadY = 1, EdgeStart = 8, EdgeEnd = 8, FlowDirection = FlowDirection.LeftToRight };
            AutomationProperties.SetName(table, T["preview.hex.caption"]);
            table.Children.Add(new TableRow(true, [TableRow.Head(T["preview.hex.offset"]), TableRow.Head(T["preview.hex.bytes"]), TableRow.Head(T["preview.hex.text"])], false) { Background = Brushes.Transparent });
            var mono = new FontFamily("Cascadia Mono, Consolas");
            TextBlock cell(string s)
            {
                var tb = TableRow.Cell(s, wrap: false);
                tb.FontFamily = mono;
                tb.FontSize = 13;
                tb.LineHeight = 18;
                return tb;
            }
            foreach (var r in Bytes.HexRows(bytes, at))
            {
                var row = new TableRow(false, [cell(r.Offset.ToString("x8")), cell(r.Hex), cell(r.Ascii)], false);
                AutomationProperties.SetName(row, $"{r.Offset:x8}: {r.Hex}");
                table.Children.Add(row);
            }
            tableBox.Content = table;
            long end = at + bytes.Length;
            page.Text = T.Get("preview.hexPage", ("from", at), ("to", Math.Max(at, end - 1)), ("size", Formats.Size(size)));
            prev.IsEnabled = at > 0;
            next.IsEnabled = !(bytes.Length < PreviewPanel.HexPage || (size is { } s && end >= s));
        }

        async Task TurnAsync(int dir)
        {
            long at = Math.Max(0, offset + dir * PreviewPanel.HexPage);
            try
            {
                var bytes = await session.Client.ReadBytesAsync(copy.Uid, at, PreviewPanel.HexPage, cancel.Token);
                cancel.Token.ThrowIfCancellationRequested();
                Render(bytes, at);
                // The page's status line: which bytes are shown now.
                Announce.Say(page.Text);
            }
            catch (OperationCanceledException) when (cancel.IsCancellationRequested)
            {
                // Closed meanwhile.
            }
            catch (Exception e) when (Arrangement.IsTrouble(e))
            {
                Announce.Alert(Formats.ErrorText(e));
            }
        }

        public void Destroy() => cancel.Cancel();
    }

    // ---- everything known about it ------------------------------------------------------------

    public sealed class Info(Copy copy, About? a) : IPart
    {
        public FrameworkElement El { get; } = InfoList(copy, a);
    }

    /// <summary>Everything known about a copy, as a list of terms and what they are (the page's dl.info).</summary>
    public static Grid InfoList(Copy copy, About? a)
    {
        var grid = new Grid { Margin = new Thickness(0, 8, 0, 8) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto, MinWidth = 112 });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        void row(string key, params UIElement?[] value)
        {
            var parts = value.Where((v) => v is not null).ToArray();
            if (parts.Length == 0) return;
            int r = grid.RowDefinitions.Count;
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var term = Build.Text(T[key], "Muted");
            term.Margin = new Thickness(0, r == 0 ? 0 : 8, 16, 0);
            // A long term wraps, so that what it is has the room in a narrow pane.
            term.MaxWidth = 150;
            Grid.SetRow(term, r);
            grid.Children.Add(term);
            var dd = Build.Stack(parts);
            dd.Margin = new Thickness(0, r == 0 ? 0 : 8, 0, 0);
            Grid.SetRow(dd, r);
            Grid.SetColumn(dd, 1);
            grid.Children.Add(dd);
        }
        TextBlock text(string s, string style = "Body") => Build.Text(s, style);
        TextBlock block(string s, string style = "Muted") => Build.Text(s, style).Margin(0, 2, 0, 0);
        TextBlock path(string p) => Build.Text(p, "Body").AsPath();
        var name = copy.Name;
        row("preview.info.path", copy.Path is { Length: > 0 } p ? path(p) : text(name is not null ? T.Get("results.nameOnly", ("name", name)) : T["results.nameUnknown"]));
        row("preview.info.when", text(Formats.TimeText(copy)));
        if (!copy.IsDir) row("preview.info.size", text(Formats.Size(copy.Size ?? a?.Size)));
        if (copy.Width is { } w && copy.Height is { } h && w > 0 && h > 0) row("preview.info.dimensions", text(T.Get("fmt.dimensions", ("w", w), ("h", h))));
        if (a?.Ext is { Length: > 0 } ext) row("preview.info.format", text(T.Get("preview.info.formatIs", ("format", Formats.FormatName(ext)))));
        var badge = Build.TierBadge(copy);
        badge.HorizontalAlignment = HorizontalAlignment.Left;
        row("preview.info.quality", badge, block(Formats.TierHelp(copy), "Body"));
        row("preview.info.state", text(Formats.StateText(copy.State)), block(Formats.StateHelp(copy.State)));
        row("preview.info.foundIn", text(Formats.KindLabel(copy.Kind, copy.KindLabel)), block(Formats.KindHelp(copy.Kind, Formats.SourceLabel(copy.Source, copy.Source))));
        var seen = Arrangement.Seen(copy);
        if (seen.Count > 0) row("preview.info.alsoIn", text(Formats.List(seen.Select((k) => Formats.KindLabel(k)))));
        if (copy.Origin is { Length: > 0 } origin) row("preview.info.keptAt", path(origin));
        if (copy.Note is { Length: > 0 } note) row("preview.info.note", text(note));
        var id = text(Arrangement.ShortId(copy));
        id.FontFamily = new FontFamily("Cascadia Mono, Consolas");
        id.FlowDirection = FlowDirection.LeftToRight;
        id.HorizontalAlignment = HorizontalAlignment.Left;
        row("preview.info.id", id, block(T["preview.info.idHint"]));
        return grid;
    }
}
