using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;

namespace Solarljos.Views.Shared;

/// <summary>
/// The places to search, one box each, all ticked at first -- except, in a search for photos, the
/// places that keep only text, which the library would leave out anyway (placesField in app.js).
/// </summary>
public sealed class PlacesField
{
    static Tr T => Tr.Instance;

    public StackPanel El { get; }
    readonly List<CheckBox> boxes = new();
    readonly CheckBox all;
    readonly TextBlock error;
    bool syncing;

    public PlacesField(string mode, IReadOnlyCollection<string>? preset)
    {
        var session = App.Session;
        var sources = session?.Sources ?? [];
        bool byDefault(Session.SourceInfo s) => !(mode == "media" && !s.Media);
        var title = Build.Text(T["adv.sources.label"], "Body");
        title.FontWeight = FontWeights.Bold;
        title.FontSize = 16;
        title.Margin = new Thickness(0, 0, 0, 12);
        all = Build.Check(T["adv.sources.all"], false);
        all.IsThreeState = false;
        all.Margin = new Thickness(0, 0, 0, 12);
        var list = new WrapPanel { Orientation = Orientation.Horizontal };
        AutomationProperties.SetName(list, T["adv.sources.label"]);
        foreach (var s in sources)
        {
            var notes = new List<string>();
            if (mode == "media" && !s.Media) notes.Add(T["adv.sources.textOnly"]);
            if (s.NeedsAdmin && session?.Elevated != true) notes.Add(T["adv.sources.needsAdmin"]);
            var label = Formats.SourceLabel(s.Id, s.Label) + (notes.Count > 0 ? $" ({string.Join("; ", notes)})" : "");
            var box = Build.Check(label, preset is not null ? preset.Contains(s.Id) : byDefault(s));
            box.Tag = s.Id;
            box.Width = 320;
            box.Margin = new Thickness(0, 0, 24, 10);
            if (notes.Count > 0 && box.Content is TextBlock tb) tb.SetResourceReference(TextBlock.ForegroundProperty, "Text2");
            box.Checked += (_, _) => Sync();
            box.Unchecked += (_, _) => Sync();
            boxes.Add(box);
            list.Children.Add(box);
        }
        all.Checked += (_, _) => SetAll(true);
        all.Unchecked += (_, _) => SetAll(false);
        error = new TextBlock { FontWeight = FontWeights.SemiBold, Visibility = Visibility.Collapsed, Margin = new Thickness(0, 8, 0, 0), TextWrapping = TextWrapping.Wrap };
        error.SetResourceReference(TextBlock.ForegroundProperty, "DangerText");
        El = Build.Stack(title, all, list, error);
        El.Margin = new Thickness(0, 8, 0, 0);
        Sync();
    }

    void SetAll(bool on)
    {
        if (syncing) return;
        syncing = true;
        foreach (var b in boxes) b.IsChecked = on;
        syncing = false;
        Sync();
    }

    void Sync()
    {
        if (syncing) return;
        syncing = true;
        int n = boxes.Count((b) => b.IsChecked == true);
        all.IsChecked = n == boxes.Count ? true : n == 0 ? false : null;
        syncing = false;
    }

    /// <summary>The ids ticked, or null when every place is, which the engine takes as all of them.</summary>
    public List<string>? Value()
    {
        var ids = boxes.Where((b) => b.IsChecked == true).Select((b) => (string)b.Tag).ToList();
        return ids.Count == boxes.Count ? null : ids;
    }

    /// <summary>Whether any place is ticked; says so below the boxes when none is, and gives the box to put the focus on.</summary>
    public Control? Validate()
    {
        bool none = boxes.Count > 0 && !boxes.Any((b) => b.IsChecked == true);
        error.Text = none ? "! " + T["adv.sources.none"] : "";
        error.Visibility = none ? Visibility.Visible : Visibility.Collapsed;
        if (none) Announce.Alert(T["adv.sources.none"]);
        return none ? all : null;
    }
}

/// <summary>
/// Places added from another disk, and whether this PC's own are left out; kept for the run.
/// Update() says them again as they stand: places are added under What is searched, while a form
/// is kept (otherDiskField in app.js).
/// </summary>
public sealed class OtherDiskField
{
    static Tr T => Tr.Instance;

    public StackPanel El { get; }
    readonly TextBlock hint;
    readonly Build.SwitchRow onlyAdded;

    public OtherDiskField()
    {
        var session = App.Session;
        var label = Build.Text(T["adv.otherDisk.label"], "Body");
        label.FontWeight = FontWeights.Bold;
        label.FontSize = 16;
        hint = Build.Text("", "Hint");
        var link = Build.Button(T["adv.otherDisk.link"], () => MainWindow.Navigate("sources"), "BtnQuiet");
        link.SetResourceReference(Control.ForegroundProperty, "AccentText");
        link.Padding = new Thickness(0);
        link.MinHeight = 32;
        onlyAdded = Build.Switch(T["adv.onlyAdded.label"], session is not null && !session.Discover);
        onlyAdded.Changed += () =>
        {
            if (App.Session is { } s) s.Discover = !onlyAdded.IsOn;
        };
        var divider = new Border { Height = 1, Margin = new Thickness(0, 24, 0, 24) };
        divider.SetResourceReference(Border.BackgroundProperty, "Divider");
        El = Build.Stack(divider, label, hint.Margin(0, 8, 0, 0), link, onlyAdded.El.Margin(-16, 8, -16, 0));
        Update();
    }

    public void Update()
    {
        var session = App.Session;
        int n = session?.AddedCount ?? 0;
        hint.Text = n > 0 ? T.Get("adv.otherDisk.count", ("count", n)) : T["adv.otherDisk.hint"];
        onlyAdded.IsOn = session is not null && !session.Discover;
        onlyAdded.El.Visibility = n > 0 ? Visibility.Visible : Visibility.Collapsed;
    }
}
