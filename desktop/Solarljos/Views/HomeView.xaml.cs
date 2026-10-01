using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Windows.Shapes;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;

namespace Solarljos.Views;

public partial class HomeView : UserControl, IPage
{
    // The last results of each kind: the view they are in, and the part of the window it is.
    static readonly (string Mode, string Route, string Nav)[] Kinds =
        [("name", "find/results", "nav.find"), ("media", "media/results", "nav.media"), ("folder", "folder/plan", "nav.folder")];

    readonly MainWindow window;
    Session? session;
    // What the links say now, so that they are made again only when that changes, and the
    // keyboard stays on the one it was on.
    string shown = "";

    public event Action? HeadingChanged { add { } remove { } }

    public HomeView(MainWindow window)
    {
        this.window = window;
        InitializeComponent();
        // Three cards side by side where they fit, one above the other where they do not.
        SizeChanged += (_, _) => Choices.Columns = ActualWidth >= 800 ? 3 : 1;
        Tr.Instance.Changed += ShowLast;
    }

    // The start's heading is the name, which the window's title does not say twice.
    public string? Heading => null;

    public void Connected(Session s)
    {
        session = s;
        // A search that ends, a plan whose files are all here, results let go of: the links follow.
        s.Jobs.Changed += (_) => ShowLast();
        ShowLast();
    }

    public void Shown(string sub) => ShowLast();

    void Choice_Click(object sender, RoutedEventArgs e) => window.Go((string)((FrameworkElement)sender).Tag);

    /// <summary>
    /// The way back to the last results of each kind (showLast in viewHome): one link for each
    /// view whose search or plan has ended and found what it found, with how much that was.
    /// </summary>
    void ShowLast()
    {
        var links = new List<(string Route, string Text)>();
        foreach (var (mode, route, nav) in Kinds)
        {
            var job = session?.Jobs.Current(mode);
            if (job is null || job.State != "done") continue;
            links.Add((route, Tr.Instance.Get("home.lastIn", ("place", Tr.Instance[nav]), ("count", job.Total ?? 0))));
        }
        var now = string.Join("\n", links.Select((l) => l.Route + "\t" + l.Text));
        if (now == shown) return;
        shown = now;
        var focused = Last.Children.OfType<Labeled>().Select((li) => li.Child).OfType<Button>().FirstOrDefault((b) => b.IsKeyboardFocusWithin)?.Tag as string;
        Last.Children.Clear();
        foreach (var (route, text) in links)
        {
            var row = LinkRow(route, text);
            // Each link an item of the list, as the page's li.
            Last.Children.Add(new Labeled { Kind = AutomationControlType.ListItem, Child = row });
            if (route == focused) row.Focus();
        }
        LastList.Visibility = links.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>A row that leads to results: a grey dot, as a state that is done, the words, and an arrow on.</summary>
    Button LinkRow(string route, string text)
    {
        var dot = new Ellipse { Width = 12, Height = 12, VerticalAlignment = VerticalAlignment.Center };
        dot.SetResourceReference(Shape.FillProperty, "Text2");
        var words = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(8, 10, 8, 10) };
        var go = new Icon { Glyph = "chevron", Width = 18, Height = 18, VerticalAlignment = VerticalAlignment.Center };
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(words, 1);
        Grid.SetColumn(go, 2);
        grid.Children.Add(dot);
        grid.Children.Add(words);
        grid.Children.Add(go);
        var b = new Button { Content = grid, Tag = route, Margin = new Thickness(-12, 0, -12, 4) };
        b.SetResourceReference(StyleProperty, "LinkRow");
        AutomationProperties.SetName(b, text);
        b.Click += (_, _) => window.Go(route);
        return b;
    }

    // ---- for the pictures of the window ------------------------------------------------------

    /// <summary>
    /// "last" or "last:name,folder": a search by name for "budget", one for photos and videos, a
    /// plan of the made-up library's thesis folder, each waited for, so that their links show.
    /// </summary>
    public async Task ActAsync(string act)
    {
        if (session is not { } s || !act.StartsWith("last", StringComparison.Ordinal)) return;
        var modes = act.Contains(':') ? act[(act.IndexOf(':') + 1)..].Split(',') : ["name", "media", "folder"];
        foreach (var mode in modes)
        {
            object body = mode switch
            {
                "media" => new { types = new[] { "image", "video" }, locations = s.PlacesFor(null), view = new { mode = "media", types = new[] { "image", "video" } } },
                "folder" => new { folder = @"C:\Users\you\Documents\thesis", locations = s.PlacesFor(null) },
                _ => (object)new { pattern = "budget", locations = s.PlacesFor(null), view = new { mode = "name", name = "budget" } },
            };
            var ended = new TaskCompletionSource();
            void onChanged(Job j)
            {
                if (j.Mode == mode && !j.Running) ended.TrySetResult();
            }
            s.Jobs.Changed += onChanged;
            try
            {
                var job = await s.Jobs.StartAsync(mode, body, () => Task.FromResult(true));
                if (job is null || !job.Running) ended.TrySetResult();
                await Task.WhenAny(ended.Task, Task.Delay(15000));
            }
            finally
            {
                s.Jobs.Changed -= onChanged;
            }
        }
    }
}
