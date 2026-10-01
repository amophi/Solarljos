using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Find;
using Solarljos.Views.Shared;

namespace Solarljos.Views;

/// <summary>
/// Find a file: its form ("find"), and what the search it started needs now ("find/results") --
/// how it goes while it runs, that it failed or was stopped, its results while they are asked
/// for, what to try when it found nothing, and what it found (viewJob in app.js). Both are kept
/// while the other is shown, and while another part of the window is: what was typed, chosen,
/// scrolled to and opened stays. The results are made again when the search moves on to
/// another of those, and both are made again, from what they held, in another language.
/// </summary>
public sealed class FindView : UserControl, IPage
{
    static Tr T => Tr.Instance;

    Session? session;
    readonly Grid host = new();
    readonly ResourceDictionary styles = new() { Source = new Uri("/Solarljos;component/Views/Find/FindStyles.xaml", UriKind.Relative) };

    FindForm form;
    /// <summary>What the form starts from when it is made: what was last searched for, or what it held.</summary>
    FindRequest formStart = new();

    // What the search needs now, as made last: its element, the job and phase it was made for.
    FrameworkElement? resultsEl;
    string resultsKey = "";
    string? resultsTitle;
    ResultsView? results;
    ProgressView? progress;

    /// <summary>"form" or "results": which of the two is in sight.</summary>
    string sub = "form";

    // What has been said of each search, so that it is said once.
    readonly HashSet<string> saidDone = new();
    readonly Dictionary<string, string> rowStates = new();
    string? jobSeen;
    readonly Dictionary<string, string> lastState = new();

    // Where the focus was in each of the two, to go back to.
    IInputElement? formFocus, resultsFocus;

    // Whether the engine's event stream has said where things are (hello): the pictures wait for it, as the page does before it shows anything.
    bool helloSeen;

    public event Action? HeadingChanged;

    public FindView()
    {
        Resources.MergedDictionaries.Add(styles);
        form = MakeForm();
        host.Children.Add(form);
        Content = host;
        Tr.Instance.Changed += OnLanguage;
        IsVisibleChanged += (_, _) =>
        {
            if (!IsVisible) results?.Hide();
        };
        host.PreviewGotKeyboardFocus += (_, e) =>
        {
            if (e.NewFocus is not DependencyObject d) return;
            if (IsWithin(d, form)) formFocus = e.NewFocus;
            else if (resultsEl is not null && IsWithin(d, resultsEl)) resultsFocus = e.NewFocus;
        };
    }

    public string? Heading => sub == "results" && resultsEl is not null ? resultsTitle : T["find.title"];

    Job? Current => session?.Jobs.Current("name");

    public void Connected(Session s)
    {
        if (session == s) return;
        session = s;
        s.Jobs.Changed += OnJobChanged;
        s.Jobs.Progressed += OnProgress;
        s.Event += (name, _) =>
        {
            if (name == "hello") helloSeen = true;
        };
        // The places to search are known now.
        ReplaceForm(form.Save());
    }

    public void Shown(string where)
    {
        var want = where switch { "results" => "results", "form" => "form", _ => sub };
        if (want == "results" && Current is null) want = "form";
        if (want == "results") ShowResults(fromOutside: true);
        else ShowForm(fromOutside: true);
    }

    // ---- the form -------------------------------------------------------------------------------

    FindForm MakeForm() => new(formStart, () => Current, StartAsync, () => ShowResults(fromOutside: false));

    void ReplaceForm(FindRequest start)
    {
        double y = form.Scroller.VerticalOffset;
        formStart = start;
        var old = form;
        form = MakeForm();
        host.Children.Remove(old);
        host.Children.Insert(0, form);
        form.Visibility = sub == "form" ? Visibility.Visible : Visibility.Collapsed;
        formFocus = null;
        if (y > 0)
        {
            var made = form;
            void back(object? o, RoutedEventArgs e)
            {
                made.Loaded -= back;
                Dispatcher.BeginInvoke(() => made.Scroller.ScrollToVerticalOffset(y), DispatcherPriority.Loaded);
            }
            made.Loaded += back;
        }
    }

    void ShowForm(bool fromOutside, string? focus = null)
    {
        sub = "form";
        form.Visibility = Visibility.Visible;
        if (resultsEl is not null) resultsEl.Visibility = Visibility.Collapsed;
        results?.Hide();
        form.Update();
        HeadingChanged?.Invoke();
        if (focus == "containing") Later(() => form.FocusContaining());
        else MoveFocus(fromOutside, formFocus, form.FocusHeading);
    }

    /// <summary>
    /// Starts a search, stopping the one already running in its place when the person agrees: the
    /// engine runs one at a time. Started from elsewhere than its form -- Try again, a shorter name
    /// -- it has the form made again from what is searched for, so that the form says it.
    /// </summary>
    async Task<bool> StartAsync(FindRequest request, bool fromForm)
    {
        if (session is null)
        {
            if (fromForm) form.ShowError(T["desktop.starting"]);
            return false;
        }
        if (!fromForm) ReplaceForm(request with { More = form.Save().More, Focus = null });
        else formStart = request;
        var job = await session.Jobs.StartAsync("name", request.Body(session), StopFirstAsync);
        if (job is null) return false;
        lastState[job.Id] = job.State;
        ShowResults(fromOutside: false);
        return true;
    }

    Task<bool> StartAsync(FindRequest request) => StartAsync(request, true);

    Task<bool> StopFirstAsync()
    {
        var owner = Window.GetWindow(this);
        if (owner is null) return Task.FromResult(false);
        return Dialog.ConfirmAsync(owner, T["progress.busy.title"], T["progress.busy.body"], T["progress.busy.ok"], T["common.cancel"]);
    }

    async void Again(FindRequest request)
    {
        try
        {
            await StartAsync(request, fromForm: false);
        }
        catch (Exception e) when (Arrangement.IsTrouble(e))
        {
            Announce.Alert(Formats.ErrorText(e));
        }
    }

    // ---- what the search needs ------------------------------------------------------------------

    /// <summary>What kind of view a job needs now.</summary>
    static string PhaseOf(Job job) => job.State != "done" ? job.State : job.Complete ? "ready" : job.LoadError is not null ? "unloaded" : "loading";

    string KeyNow() => Current is { } job ? $"{job.Id}:{PhaseOf(job)}" : "";

    /// <summary>Makes again what the search needs, from what the results held when it is the same search.</summary>
    void BuildResults(ResultsState? saved)
    {
        var job = Current;
        DropResults();
        if (job is null || session is null) return;
        resultsKey = KeyNow();
        var phase = PhaseOf(job);
        void back() => ShowForm(fromOutside: false);
        switch (phase)
        {
            case "running":
                progress = new ProgressView(job);
                resultsEl = progress;
                resultsTitle = ProgressView.JobTitle(job);
                break;
            case "failed":
                resultsEl = StatePage.Failed(job, () => Again(FindRequest.Of(job)), back);
                resultsTitle = T["error.title"];
                break;
            case "cancelled":
                resultsEl = StatePage.Stopped(job, () => Again(FindRequest.Of(job)), back);
                resultsTitle = T["progress.stopped.title"];
                break;
            case "loading":
            case "unloaded":
                resultsEl = StatePage.Loading(job, () =>
                {
                    job.LoadError = null;
                    _ = session.Jobs.FetchItemsAsync(job);
                    Rebuild();
                });
                resultsTitle = ProgressView.JobTitle(job);
                if (job.LoadError is null && job.Fetching is null) _ = session.Jobs.FetchItemsAsync(job);
                break;
            default:
                if (job.Items.Count == 0)
                {
                    resultsEl = EmptyView.Make(session, job, Again, (focus) => ToForm(focus), back, out _);
                    resultsTitle = EmptyView.Title(FindRequest.Of(job));
                }
                else
                {
                    results = new ResultsView(session, job, saved, back);
                    resultsEl = results;
                    resultsTitle = results.Heading;
                }
                break;
        }
        resultsEl.Visibility = sub == "results" ? Visibility.Visible : Visibility.Collapsed;
        host.Children.Add(resultsEl);
        resultsFocus = null;
    }

    void DropResults()
    {
        results?.Destroy();
        if (resultsEl is not null) host.Children.Remove(resultsEl);
        resultsEl = null;
        results = null;
        progress = null;
        resultsKey = "";
        resultsTitle = null;
    }

    /// <summary>Makes again what the search needs, in sight if it was, with the focus on its heading.</summary>
    void Rebuild()
    {
        bool focusInside = IsKeyboardFocusWithin;
        BuildResults(null);
        HeadingChanged?.Invoke();
        if (sub == "results" && resultsEl is not null && (focusInside || Keyboard.FocusedElement is null)) Later(() => FocusHeadingOf(resultsEl));
    }

    void ShowResults(bool fromOutside)
    {
        if (Current is null)
        {
            DropResults();
            ShowForm(fromOutside);
            return;
        }
        bool fresh = resultsEl is null || resultsKey != KeyNow();
        if (fresh) BuildResults(null);
        sub = "results";
        form.Visibility = Visibility.Collapsed;
        resultsEl!.Visibility = Visibility.Visible;
        HeadingChanged?.Invoke();
        if (fresh) MoveFocus(fromOutside, null, () => FocusHeadingOf(resultsEl));
        else MoveFocus(fromOutside, resultsFocus, () => FocusHeadingOf(resultsEl));
    }

    /// <summary>Sends the person to the form, filled in as it is, and to one of its boxes: a word the file contained.</summary>
    void ToForm(string? focus)
    {
        ReplaceForm(form.Save() with { Focus = focus });
        ShowForm(fromOutside: false, focus);
    }

    // ---- the engine's news ----------------------------------------------------------------------

    void OnJobChanged(Job job)
    {
        var current = Current;
        if (job.Mode != "name" && resultsKey.Length == 0) return;
        if (current is not null && current.Id == job.Id)
        {
            // Said once, when it is done: how many it found.
            lastState.TryGetValue(job.Id, out var was);
            if (job.State == "done" && was is "running" or null && saidDone.Add(job.Id))
                Announce.Say(T.Get("a11y.searchDone", ("count", job.Total ?? 0)));
            lastState[job.Id] = job.State;
        }
        form.Update();
        if (KeyNow() == resultsKey) return;
        if (current is null)
        {
            DropResults();
            if (sub == "results") ShowForm(fromOutside: !IsKeyboardFocusWithin);
            return;
        }
        if (sub == "results" && IsVisible) Rebuild();
        else BuildResults(null);
    }

    void OnProgress(Job job)
    {
        if (Current?.Id != job.Id) return;
        if (jobSeen != job.Id)
        {
            jobSeen = job.Id;
            rowStates.Clear();
        }
        // Said of the search in sight only: each place as it is done.
        foreach (var row in job.Rows)
        {
            rowStates.TryGetValue(row.Id, out var was);
            rowStates[row.Id] = row.Status;
            bool ended = row.Status is "done" or "failed" or "skipped";
            if (ended && was != row.Status && sub == "results" && IsVisible)
                Announce.Say(T.Get("a11y.sourceDone", ("source", Formats.SourceLabel(row.Id, row.Label)), ("result", ProgressView.RowResult(row))));
        }
        if (progress?.Job == job) progress.Update();
    }

    // ---- another language -----------------------------------------------------------------------

    /// <summary>Both made again in the language now chosen, from what each held: the form, the results' choices.</summary>
    void OnLanguage()
    {
        ReplaceForm(form.Save());
        if (resultsEl is not null)
        {
            var saved = results?.Save();
            bool focusInside = resultsEl.IsKeyboardFocusWithin;
            BuildResults(saved);
            if (focusInside && sub == "results") Later(() => FocusHeadingOf(resultsEl));
        }
        HeadingChanged?.Invoke();
    }

    // ---- the focus ------------------------------------------------------------------------------

    static bool IsWithin(DependencyObject d, DependencyObject ancestor)
    {
        for (var at = d; at is not null; at = VisualTreeHelper.GetParent(at) ?? LogicalTreeHelper.GetParent(at))
            if (at == ancestor) return true;
        return false;
    }

    void Later(Action a) => Dispatcher.BeginInvoke(a, DispatcherPriority.Loaded);

    /// <summary>
    /// Where the focus goes when one of the two comes into sight: back where it was, else to its
    /// heading, as the page does; but not away from the rail when that is where the person is,
    /// going through its parts with the arrow keys.
    /// </summary>
    void MoveFocus(bool fromOutside, IInputElement? remembered, Action toHeading)
    {
        if (fromOutside)
        {
            var now = Keyboard.FocusedElement as DependencyObject;
            bool elsewhere = now is UIElement { IsVisible: true } && !IsWithin(now, this);
            if (elsewhere) return;
        }
        Later(() =>
        {
            if (remembered is UIElement { IsVisible: true, Focusable: true } r) r.Focus();
            else toHeading();
        });
    }

    /// <summary>The first heading of a view, made able to take the focus, for a screen reader to start there.</summary>
    static void FocusHeadingOf(FrameworkElement? el)
    {
        if (el is null) return;
        if (el is ResultsView rv)
        {
            rv.FocusHeading();
            return;
        }
        var h = FindHeading(el);
        if (h is null) return;
        h.Focusable = true;
        h.FocusVisualStyle = null;
        KeyboardNavigation.SetIsTabStop(h, false);
        h.Focus();
    }

    static TextBlock? FindHeading(DependencyObject root)
    {
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
        {
            if (child is TextBlock tb && AutomationProperties.GetHeadingLevel(tb) == AutomationHeadingLevel.Level1) return tb;
            if (FindHeading(child) is { } found) return found;
        }
        return null;
    }

    // ---- for the pictures of the window ---------------------------------------------------------

    /// <summary>
    /// What to do before a picture, as acts separated by "|": search:&lt;name&gt; fills in the form
    /// and searches, and waits for it to end (a "slow" one only a moment); form, more, pick,
    /// submit-empty; preview:&lt;part of a name&gt;, tab:&lt;n&gt;, versions:&lt;part of a name&gt;,
    /// view:copies, filter:&lt;text&gt;, restore, scroll:&lt;pixels&gt;, lang:&lt;code&gt;, wait:&lt;ms&gt;; set-where,
    /// set-since, set-deleted (in the form, before a search); switch:deleted|dates|places, sort, more-rows,
    /// encoding:&lt;name&gt;, wrap (on the results); stop.
    /// </summary>
    public async Task ActAsync(string act)
    {
        // A job started before the stream's first hello is handled would be taken for one the engine no longer has.
        for (var until = DateTime.UtcNow.AddSeconds(3); !helloSeen && DateTime.UtcNow < until;) await Task.Delay(50);
        foreach (var step in act.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var (name, arg) = step.IndexOf(':') is var i and >= 0 ? (step[..i], step[(i + 1)..]) : (step, "");
            await StepAsync(name, arg);
            await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ApplicationIdle);
        }
    }

    async Task StepAsync(string name, string arg)
    {
        switch (name)
        {
            case "search":
                {
                    ShowForm(fromOutside: false);
                    ReplaceForm(form.Save() with { Name = arg });
                    var request = form.Values(false);
                    await StartAsync(request with { Since = FindRequest.SinceMs(request.SinceChoice, request.SinceDate) }, true);
                    var job = Current;
                    var until = DateTime.UtcNow.AddSeconds(arg.StartsWith("slow") ? 1.5 : 30);
                    while (job is not null && DateTime.UtcNow < until && (job.Running || (job.State == "done" && !job.Complete && job.LoadError is null)))
                        await Task.Delay(50);
                    if (job is not null && !job.Running && sub == "results" && resultsKey != KeyNow()) Rebuild();
                    break;
                }
            case "form":
                ShowForm(fromOutside: false);
                break;
            case "set-where":
                ReplaceForm(form.Save() with { Where = arg });
                break;
            case "set-since":
                ReplaceForm(form.Save() with { SinceChoice = arg, More = true });
                break;
            case "set-deleted":
                ReplaceForm(form.Save() with { DeletedOnly = true });
                break;
            case "switch":
                results?.Flip(arg);
                break;
            case "sort":
                results?.SortBy(arg);
                break;
            case "more-rows":
                results?.ShowMoreRows();
                break;
            case "encoding":
                results?.Preview?.Read(arg, wrap: false);
                await Task.Delay(300);
                break;
            case "wrap":
                results?.Preview?.Read(null, wrap: true);
                break;
            case "press":
                {
                    // A key as the keyboard sends it, n times ("Tab*3"), for a picture of where the
                    // focus goes: Tab and the arrows move it as keyboard navigation does, the rest go
                    // to what has the focus, as a key pressed there.
                    var (keyName, times) = arg.Split('*') is [var k, var n] && int.TryParse(n, out var c) ? (k, c) : (arg, 1);
                    bool shift = keyName.StartsWith("Shift+", StringComparison.Ordinal);
                    if (!Enum.TryParse<Key>(shift ? keyName[6..] : keyName, out var key)) break;
                    var source = PresentationSource.FromVisual(Window.GetWindow(this));
                    for (int i = 0; i < times && source is not null; i++)
                    {
                        var at = Keyboard.FocusedElement as UIElement;
                        FocusNavigationDirection? way = key switch
                        {
                            Key.Tab => shift ? FocusNavigationDirection.Previous : FocusNavigationDirection.Next,
                            Key.Left => FocusNavigationDirection.Left,
                            Key.Right => FocusNavigationDirection.Right,
                            Key.Up => FocusNavigationDirection.Up,
                            Key.Down => FocusNavigationDirection.Down,
                            _ => null,
                        };
                        if (way is { } w) at?.MoveFocus(new TraversalRequest(w));
                        else if (at is not null)
                        {
                            var down = new KeyEventArgs(Keyboard.PrimaryDevice, source, Environment.TickCount, key) { RoutedEvent = Keyboard.PreviewKeyDownEvent };
                            at.RaiseEvent(down);
                            if (!down.Handled)
                            {
                                down = new KeyEventArgs(Keyboard.PrimaryDevice, source, Environment.TickCount, key) { RoutedEvent = Keyboard.KeyDownEvent };
                                at.RaiseEvent(down);
                            }
                        }
                        await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ApplicationIdle);
                    }
                    break;
                }
            case "unloaded":
                // Only for a picture: the results taken for not all here, and asking for them failed.
                if (Current is { State: "done" } done)
                {
                    done.Complete = false;
                    done.LoadError = new HttpRequestException("made up");
                    Rebuild();
                }
                break;
            case "stop":
                if (session is not null && Current is { Running: true } running)
                {
                    await session.Jobs.StopAsync(running);
                    await Task.Delay(300);
                }
                break;
            case "more":
                if (FindExpander(form) is { } e) e.IsExpanded = true;
                break;
            case "pick":
                ReplaceForm(form.Save() with { SinceChoice = "pick", More = true, SinceDate = arg });
                break;
            case "type":
                ReplaceForm(form.Save() with { Types = [arg], More = true });
                break;
            case "submit-empty":
                ShowForm(fromOutside: false);
                ReplaceForm(form.Save() with { Name = "", Containing = "", Types = [], Where = arg });
                await Task.Delay(100);
                form.Submit();
                break;
            case "preview":
                {
                    await EnsureResultsAsync();
                    if (results is null) break;
                    // By a part of its name, or by its kind: "photo", "video", "folder".
                    var g = results.Groups.FirstOrDefault((x) => (x.Name ?? "").Contains(arg, StringComparison.OrdinalIgnoreCase))
                        ?? results.Groups.FirstOrDefault((x) => Arrangement.FileIcon(x.Best) == arg)
                        ?? results.Groups.FirstOrDefault();
                    if (g is not null) results.OpenPreview(g.Best, null, 0, true);
                    await Task.Delay(600);
                    break;
                }
            case "tab":
                if (results?.Preview is { } p && int.TryParse(arg, out int t)) p.Choose(t);
                await Task.Delay(400);
                break;
            case "versions":
                {
                    await EnsureResultsAsync();
                    var g = results?.Groups.FirstOrDefault((x) => (x.Name ?? "").Contains(arg, StringComparison.OrdinalIgnoreCase) && x.Versions.Count > 1);
                    if (g is not null) results!.OpenVersions(g.Key);
                    break;
                }
            case "view":
                await EnsureResultsAsync();
                results?.Choose(v: arg);
                break;
            case "filter":
                await EnsureResultsAsync();
                results?.Choose(q2: arg);
                break;
            case "restore":
                {
                    await EnsureResultsAsync();
                    if (results is null) break;
                    var c = results.Preview?.Copy ?? results.Groups.FirstOrDefault((x) => !x.IsDir)?.Best;
                    if (c is not null) results.Restore([c], null, modal: false);
                    await Task.Delay(1500);
                    break;
                }
            case "scroll":
                if (double.TryParse(arg, out var y))
                {
                    var sv = sub == "results" ? results?.Scroller : form.Scroller;
                    sv?.ScrollToVerticalOffset(y);
                }
                break;
            case "lang":
                Tr.Instance.Use(arg);
                Theme.UseFontFor(Tr.Instance.Code);
                if (session is not null) await session.UseLanguageAsync(Tr.Instance.Code);
                break;
            case "wait":
                if (int.TryParse(arg, out var ms)) await Task.Delay(ms);
                break;
        }
    }

    async Task EnsureResultsAsync()
    {
        if (results is null && Current is null) await StepAsync("search", "budget");
        if (sub != "results") ShowResults(fromOutside: false);
        await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ApplicationIdle);
    }

    static Expander? FindExpander(DependencyObject root)
    {
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
        {
            if (child is Expander e) return e;
            if (FindExpander(child) is { } found) return found;
        }
        return null;
    }
}
