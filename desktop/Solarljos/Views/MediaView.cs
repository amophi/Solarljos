using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Media;
using Solarljos.Views.Shared;

namespace Solarljos.Views;

/// <summary>
/// Photos and videos: the form that searches for them ("media"), and what the last search shows
/// ("media/results") -- how it goes, that it failed or was stopped, that it found nothing, or the
/// grid of what it found (viewMediaForm and viewJob in src/gui/ui/app.js). Both are kept while
/// the other is shown, and while another part of the window is: what was typed, chosen, scrolled
/// and selected stays. A view of results is made again when its search needs another kind of view
/// -- the grid once the search is done -- and goes when its search does. In another language
/// each is made again from what it held.
/// </summary>
public sealed class MediaView : UserControl, IPage
{
    static Tr T => Tr.Instance;

    public event Action? HeadingChanged;

    readonly ResourceDictionary look = new() { Source = new Uri("pack://application:,,,/Solarljos;component/Views/Media/MediaLook.xaml") };
    readonly Thumbs thumbs = new();
    readonly HashSet<string> announced = new();
    Session? session;
    MediaForm? form;
    FrameworkElement? results;
    TextBlock? resultsTitle;
    string resultsHeading = "";
    string resultsKey = "";
    MediaGrid? grid;
    ProgressView? progress;
    string? thumbsJob;
    bool showingResults;
    bool progressPending;
    IInputElement? formFocus;
    IInputElement? resultsFocus;

    /// <summary>Dialogs open without holding the window, so that a picture can be taken of them (Dev/Shot.cs).</summary>
    public bool ForShot { get; private set; }

    public MediaView()
    {
        Resources.MergedDictionaries.Add(look);
        Content = Build.Page(Build.Stack(Build.Heading(T["media.title"]), Build.Text(T["desktop.starting"], "Muted").Margin(0, 16, 0, 0)));
        Tr.Instance.Changed += Rebuild;
        // Where the focus was in each view, to come back to it.
        PreviewGotKeyboardFocus += (_, e) =>
        {
            if (showingResults) resultsFocus = e.NewFocus;
            else formFocus = e.NewFocus;
        };
    }

    public string? Heading => showingResults ? resultsHeading : T["media.title"];

    public void Connected(Session s)
    {
        session = s;
        s.Jobs.Changed += OnChanged;
        s.Jobs.Progressed += OnProgressed;
        form = new MediaForm(this, s, null, look);
        if (!showingResults) Content = form.El;
        HeadingChanged?.Invoke();
    }

    public void Shown(string sub)
    {
        if (session is null) return;
        if (sub == "results" || (sub == "" && showingResults)) ShowResults();
        else ShowForm(false);
    }

    // ---- the form ----------------------------------------------------------------------------------

    /// <summary>
    /// The form, as it was left; `fresh` from the results' "New search", which starts the person at
    /// the form's heading as a new view does.
    /// </summary>
    public void ShowForm(bool fresh)
    {
        if (session is null || form is null) return;
        showingResults = false;
        form.Update();
        Content = form.El;
        HeadingChanged?.Invoke();
        Restore(fresh ? null : formFocus, form.Title);
    }

    /// <summary>Starts a search from the form, or again from its results, and shows how it goes.</summary>
    public async Task StartAsync(MediaRequest request, MediaForm? from, Dictionary<string, object?>? extra = null)
    {
        if (session is null) return;
        if (from is not null) from.Busy = true;
        try
        {
            object body = request.Body(session);
            if (extra is not null && body is Dictionary<string, object?> d) foreach (var (k, v) in extra) d[k] = v;
            var job = await session.Jobs.StartAsync("media", body, () => Dialog.ConfirmAsync(Window.GetWindow(this)!,
                T["progress.busy.title"], T["progress.busy.body"], T["progress.busy.ok"], T["common.cancel"]));
            if (job is null) return;
            MainWindow.Navigate("media/results");
        }
        catch (Exception e) when (e is CoreException or HttpRequestException)
        {
            if (from is not null) from.ShowError(Formats.ErrorText(e));
            else Announce.Alert(Formats.ErrorText(e));
        }
        finally
        {
            if (from is not null) from.Busy = false;
        }
    }

    /// <summary>
    /// A search made again from its results -- Try again, Search again, without the limits -- with
    /// its form made again from it, so that the form says what was searched for.
    /// </summary>
    public async Task AgainAsync(MediaRequest request)
    {
        if (session is null) return;
        form = new MediaForm(this, session, request, look);
        formFocus = null;
        await StartAsync(request, null);
    }

    // ---- what the search shows ---------------------------------------------------------------------

    static string PhaseOf(Job job)
    {
        if (job.State != "done") return job.State;
        if (job.Kind == "rebuild" || job.Complete) return "ready";
        return job.LoadError is not null ? "unloaded" : "loading";
    }

    static string KeyOf(Job job) => $"{job.Id}:{PhaseOf(job)}";

    void ShowResults()
    {
        if (session is null) return;
        var job = session.Jobs.Current("media");
        if (job is null)
        {
            // Its search is gone: the form, as the page goes back to it.
            DropResults();
            ShowForm(false);
            return;
        }
        bool fresh = false;
        if (results is null || resultsKey != KeyOf(job))
        {
            Make(job, null);
            fresh = true;
        }
        showingResults = true;
        Content = results;
        HeadingChanged?.Invoke();
        Restore(fresh ? null : resultsFocus, resultsTitle);
    }

    /// <summary>The view a job needs now: how it goes, why it failed or stopped, its results being fetched, nothing found, or the grid.</summary>
    void Make(Job job, MediaGrid.State? saved)
    {
        if (session is null) return;
        var s = session;
        DropResults();
        if (thumbsJob != job.Id)
        {
            thumbs.Reset();
            thumbsJob = job.Id;
        }
        var phase = PhaseOf(job);
        resultsKey = KeyOf(job);
        resultsFocus = null;
        void again() => _ = AgainAsync(MediaRequest.Of(job));
        void back() => ShowForm(false);
        switch (phase)
        {
            case "running":
                progress = new ProgressView(job);
                results = progress;
                resultsHeading = ProgressView.JobTitle(job);
                break;
            case "failed":
                results = StatePage.Failed(job, again, back);
                resultsHeading = T["error.title"];
                break;
            case "cancelled":
                results = StatePage.Stopped(job, again, back);
                resultsHeading = T["progress.stopped.title"];
                break;
            case "loading":
            case "unloaded":
                results = StatePage.Loading(job, () =>
                {
                    job.LoadError = null;
                    _ = s.Jobs.FetchItemsAsync(job);
                    if (showingResults) ShowResults();
                });
                resultsHeading = ProgressView.JobTitle(job);
                if (job.LoadError is null) _ = s.Jobs.FetchItemsAsync(job);
                break;
            default:
                if (job.Received == 0 || !job.Copies().Any())
                {
                    results = EmptyMedia.Make(this, s, job);
                    resultsHeading = T["empty.media.title"];
                }
                else
                {
                    grid = new MediaGrid(this, s, job, thumbs, look, saved);
                    results = grid;
                    resultsHeading = T["grid.title"];
                }
                break;
        }
        resultsTitle = grid?.Title ?? FindHeading(results);
        if (grid is null && resultsTitle is not null) FocusableHeading(resultsTitle);
    }

    /// <summary>
    /// A heading the focus can be put on, for a screen reader to start at, and that Tab passes by;
    /// focused, it does not scroll the view, which stays where it was (focus({ preventScroll })).
    /// </summary>
    internal static void FocusableHeading(TextBlock heading)
    {
        heading.Focusable = true;
        heading.FocusVisualStyle = null;
        KeyboardNavigation.SetIsTabStop(heading, false);
        heading.RequestBringIntoView += (_, e) => e.Handled = true;
    }

    void DropResults()
    {
        grid?.Open?.Close();
        results = null;
        grid = null;
        progress = null;
        resultsTitle = null;
        resultsKey = "";
    }

    static TextBlock? FindHeading(DependencyObject? root)
    {
        if (root is null) return null;
        if (root is TextBlock t && System.Windows.Automation.AutomationProperties.GetHeadingLevel(t) == System.Windows.Automation.AutomationHeadingLevel.Level1) return t;
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
            if (FindHeading(child) is { } found) return found;
        return null;
    }

    /// <summary>
    /// A search has moved on -- ended, its results all here, let go of -- and the view of it follows,
    /// shown or not: made again when it needs another kind of view, gone when its search is.
    /// </summary>
    void OnChanged(Job job)
    {
        if (session is null) return;
        form?.Update();
        var current = session.Jobs.Current("media");
        if (current == job && job.Kind == "search" && job.State == "done" && announced.Add(job.Id))
            Announce.Say(T.Get("a11y.searchDone", ("count", job.Total ?? 0)));
        if (current is null)
        {
            if (results is null) return;
            DropResults();
            if (showingResults) ShowForm(false);
            return;
        }
        if (results is not null && resultsKey == KeyOf(current))
        {
            progress?.Update();
            return;
        }
        if (showingResults)
        {
            Make(current, null);
            Content = results;
            HeadingChanged?.Invoke();
            Restore(null, resultsTitle);
        }
        else DropResults();
    }

    /// <summary>A search went a step further: its rows drawn again, once for many steps at a time.</summary>
    void OnProgressed(Job job)
    {
        if (progress?.Job != job || progressPending) return;
        progressPending = true;
        Dispatcher.BeginInvoke(DispatcherPriority.Render, () =>
        {
            progressPending = false;
            progress?.Update();
        });
    }

    /// <summary>The focus where it was in a view kept, else on its heading, so that a screen reader starts there.</summary>
    void Restore(IInputElement? was, TextBlock? heading)
    {
        Dispatcher.BeginInvoke(DispatcherPriority.Loaded, () =>
        {
            if (was is UIElement e && e.IsVisible && IsAncestorOf(e) && e.Focusable)
            {
                Keyboard.Focus(e);
                return;
            }
            if (heading is not null && heading.IsVisible) Keyboard.Focus(heading);
        });
    }

    /// <summary>Every view made again in the language now chosen, from what each held: the form's values, the grid's choices.</summary>
    void Rebuild()
    {
        if (session is null)
        {
            Content = Build.Page(Build.Stack(Build.Heading(T["media.title"]), Build.Text(T["desktop.starting"], "Muted").Margin(0, 16, 0, 0)));
            HeadingChanged?.Invoke();
            return;
        }
        var kept = form?.Save();
        // The view in sight stays about where it was scrolled; the grid keeps its own place.
        double y = grid is not null && Content == grid ? 0 : ScrollerOf(Content)?.VerticalOffset ?? 0;
        form = new MediaForm(this, session, kept, look, saved: kept is not null);
        formFocus = null;
        var job = session.Jobs.Current("media");
        if (results is not null && job is not null)
        {
            var saved = grid?.Save();
            Make(job, saved);
        }
        else DropResults();
        Content = showingResults && results is not null ? results : form.El;
        if (showingResults && results is null) showingResults = false;
        HeadingChanged?.Invoke();
        Restore(null, showingResults ? resultsTitle : form.Title);
        if (y > 0) Dispatcher.BeginInvoke(DispatcherPriority.Loaded, () => ScrollerOf(Content)?.ScrollToVerticalOffset(y));
    }

    static ScrollViewer? ScrollerOf(object? view) => view switch
    {
        ScrollViewer s => s,
        MediaGrid => null,
        ContentControl c => ScrollerOf(c.Content),
        _ => null,
    };

    // ---- for the pictures of the window (Dev/Shot.cs) ------------------------------------------------

    /// <summary>
    /// Steps joined by "+": search (the form as it is, sent, and its results waited for); none,
    /// pick, more, where:Pictures, dates:2026-09-01..2026-09-30, submit (the form's checks); slow,
    /// fail, empty (a search the made-up engine holds, fails or finds nothing in); stop; form,
    /// results; page:7 (fewer tiles at a time); select:3, key:Right (a key on the tile in focus),
    /// lightbox:0 or lightbox:video, restore, scroll:600, jump:2026-08 or jump:none, choose:full
    /// (smaller, tiny, dates); relang:ar; wait:500.
    /// </summary>
    public async Task ActAsync(string act)
    {
        ForShot = true;
        foreach (var step in act.Split('+', StringSplitOptions.RemoveEmptyEntries))
        {
            // What the step before left to do -- the focus put back, a layout -- done first.
            await Dispatcher.Yield(DispatcherPriority.ApplicationIdle);
            await StepAsync(step.Trim());
        }
    }

    async Task StepAsync(string step)
    {
        var parts = step.Split(':', 2);
        var name = parts[0];
        var arg = parts.Length > 1 ? parts[1] : "";
        if (session is null || form is null) return;
        switch (name)
        {
            case "search":
                await form.SubmitForShotAsync();
                await UntilAsync(() => session.Jobs.Current("media") is { } j && !j.Running && results is not null && resultsKey == KeyOf(j) && PhaseOf(j) is not "loading");
                await UntilAsync(() => grid is null || !grid.ThumbsBusy, 20000);
                break;
            case "submit":
                await form.SubmitForShotAsync();
                break;
            case "none":
                form.SetTypes(false, false);
                break;
            case "pick":
                form.Pick("pick");
                break;
            case "dates":
                {
                    var d = arg.Split("..");
                    DateTime? at(int i) => d.Length > i && DateTime.TryParse(d[i], System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var x) ? x : null;
                    form.Pick("pick");
                    form.SetDates(at(0), at(1));
                    break;
                }
            case "where":
                form.SetWhere(arg);
                break;
            case "more":
                form.OpenMore();
                break;
            case "slow":
            case "fail":
            case "empty":
                {
                    var pattern = name == "empty" ? "zzz" : name;
                    await StartAsync(new MediaRequest(), null, new() { ["pattern"] = pattern });
                    if (name == "slow") await UntilAsync(() => progress is not null && session.Jobs.Current("media") is { Rows.Count: > 3 });
                    else await UntilAsync(() => session.Jobs.Current("media") is { Running: false } j && resultsKey == KeyOf(j));
                    await Task.Delay(300);
                    break;
                }
            case "stop":
                if (session.Jobs.Current("media") is { Running: true } running) await session.Jobs.StopAsync(running);
                await UntilAsync(() => session.Jobs.Current("media") is { Running: false } j && resultsKey == KeyOf(j));
                break;
            case "form":
                ShowForm(false);
                break;
            case "results":
                MainWindow.Navigate("media/results");
                break;
            case "select":
                grid?.SelectFirst(int.TryParse(arg, out var n) ? n : 3);
                break;
            case "lightbox":
                grid?.OpenLightbox(arg == "video" ? grid.List.FindIndex(MediaData.IsVideo) : int.TryParse(arg, out var i) ? i : 0);
                await UntilAsync(() => grid?.Open is { Ready: true });
                await Task.Delay(400);
                break;
            case "restore":
                grid?.OpenRestore();
                await Task.Delay(1500);
                break;
            case "scroll":
                UpdateLayout();
                if (!showingResults && form.El is ScrollViewer fs) fs.ScrollToVerticalOffset(fs.VerticalOffset + (double.TryParse(arg, out var fy) ? fy : 600));
                else if (grid is null && results is ScrollViewer rs) rs.ScrollToVerticalOffset(rs.VerticalOffset + (double.TryParse(arg, out var ry) ? ry : 600));
                grid?.ScrollBy(double.TryParse(arg, out var y) ? y : 600);
                await Task.Delay(300);
                await UntilAsync(() => grid is null || !grid.ThumbsBusy, 20000);
                break;
            case "jump":
                grid?.Jump(arg is "" or "none" ? null : arg);
                await Task.Delay(300);
                await UntilAsync(() => grid is null || !grid.ThumbsBusy, 20000);
                break;
            case "choose":
                grid?.Choose(arg);
                await Task.Delay(300);
                await UntilAsync(() => grid is null || !grid.ThumbsBusy, 20000);
                break;
            case "relang":
                Tr.Instance.Use(arg);
                Theme.UseFontFor(arg);
                await session.UseLanguageAsync(arg);
                await Task.Delay(300);
                await UntilAsync(() => grid is null || !grid.ThumbsBusy, 20000);
                break;
            case "calendar":
                {
                    // A popup is not a window the picture takes: the calendar the date box opens, in one of its own.
                    var cal = new Calendar { Style = (Style)look["MediaCalendar"], DisplayDate = new DateTime(2026, 9, 1), SelectedDate = new DateTime(2026, 9, 15) };
                    cal.Language = System.Windows.Markup.XmlLanguage.GetLanguage(T.Culture.Name);
                    var w = new Window
                    {
                        Owner = Window.GetWindow(this), Content = cal, SizeToContent = SizeToContent.WidthAndHeight, WindowStyle = WindowStyle.None,
                        ShowInTaskbar = false, ShowActivated = false, Left = -32000, Top = -32000, FlowDirection = T.Direction,
                    };
                    w.Resources.MergedDictionaries.Add(look);
                    w.SetResourceReference(BackgroundProperty, "Bg");
                    w.SetResourceReference(FontFamilyProperty, "UiFont");
                    w.Show();
                    await Task.Delay(300);
                    break;
                }
            case "page":
                if (int.TryParse(arg, out var size) && size > 0) MediaData.GridPage = size;
                break;
            case "key":
                if (Enum.TryParse<Key>(arg, out var key)) grid?.Press(key);
                await Task.Delay(200);
                break;
            case "wait":
                await Task.Delay(int.TryParse(arg, out var ms) ? ms : 500);
                break;
        }
    }

    static async Task UntilAsync(Func<bool> done, int ms = 20000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(ms);
        while (!done() && DateTime.UtcNow < until) await Task.Delay(100);
    }
}
