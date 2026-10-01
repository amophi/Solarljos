using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Folder;
using Solarljos.Views.Shared;

namespace Solarljos.Views;

/// <summary>
/// Bring back a folder: its form ("folder"), the plan of what was inside it ("folder/plan"), and
/// the folder being written and what came of it ("folder/done"), as the page's three routes of
/// the part (ROUTES in src/gui/ui/app.js). Each is kept while another is shown, as it was left:
/// what was typed, ticked, opened and scrolled to. A view of a job is made again when its job
/// needs another kind of view -- the plan after the progress -- and goes when its job does; a
/// change of language makes every view again from what it held.
/// </summary>
public sealed partial class FolderView : UserControl, IPage
{
    static Tr T => Tr.Instance;

    /// <summary>A route's view, and what it was made for: its job and how that stood (the page's slot).</summary>
    sealed class Slot
    {
        public Part? Part;
        public string Key = "";
        public bool Fresh = true;
        public IInputElement? Focus;
    }

    readonly Grid host = new();
    readonly Dictionary<string, Slot> slots = new();
    string active = "";
    bool formHasPlaces;
    // What the form starts from when it is made (state.forms.folder), and what each plan was asked.
    FolderRequest form = new();
    readonly Dictionary<string, FolderRequest> requests = new();
    // Jobs whose end was said aloud, and how each place of the plan in sight last stood.
    readonly HashSet<string> announced = new();
    readonly Dictionary<string, string> rowStatus = new();

    public event Action? HeadingChanged;

    /// <summary>
    /// Shows a copy, as the page's preview does, from a file's row of a plan (Enter, or a click on
    /// its name) or from the list of the files left out, with what it was opened from. The preview
    /// is not this part's: where the program has one, it is given here. Without it Enter on a file
    /// does nothing, and the files left out have no Preview button.
    /// </summary>
    public static Action<Copy, FrameworkElement>? ShowPreview { get; set; }

    public FolderView()
    {
        Resources.MergedDictionaries.Add(new ResourceDictionary
        {
            Source = new Uri("pack://application:,,,/Solarljos;component/Views/Folder/FolderStyles.xaml", UriKind.Absolute),
        });
        Content = host;
        host.PreviewGotKeyboardFocus += (_, e) =>
        {
            foreach (var slot in slots.Values)
                if (slot.Part?.El is { } el && e.NewFocus is System.Windows.Media.Visual v && el.IsAncestorOf(v)) slot.Focus = e.NewFocus;
        };
        Tr.Instance.Changed += RebuildAll;
        Show("");
    }

    public string? Heading => slots.TryGetValue(active, out var s) && s.Part is { } p ? p.Heading : T["folder.title"];

    public void Connected(Session session)
    {
        session.Jobs.Changed += OnChanged;
        session.Jobs.Progressed += OnProgressed;
        // The places to search are known now: a form made before is made again with them, as it was.
        if (!formHasPlaces && slots.TryGetValue("", out var slot) && slot.Part is FolderForm f)
        {
            Build("", f.Values());
            slot.Fresh = false;
            ShowOnly(active);
        }
    }

    public void Shown(string sub)
    {
        // "fill:<folder>": sent here to bring back a folder found elsewhere, the form filled in with it.
        if (sub.StartsWith("fill:", StringComparison.Ordinal))
        {
            Prefill(sub[5..]);
            Show("");
            return;
        }
        Show(sub switch { "plan" => "plan", "done" => "done", "" => active, _ => "" });
    }

    // ---- routes ----------------------------------------------------------------------------------

    /// <summary>The job a route's view shows: the plan of the form, or the folder being written.</summary>
    static Job? JobFor(string route) => route switch
    {
        "plan" => App.Session?.Jobs.Current("folder"),
        "done" => App.Session?.Jobs.Current("rebuild"),
        _ => null,
    };

    /// <summary>What kind of view a job needs now (phaseOf).</summary>
    static string PhaseOf(Job job)
    {
        if (job.State != "done") return job.State;
        if (job.Kind == "rebuild" || job.Complete) return "ready";
        return job.LoadError is not null ? "unloaded" : "loading";
    }

    static string KeyOf(string route) => JobFor(route) is { } j ? $"{j.Id}:{PhaseOf(j)}" : "";

    /// <summary>Makes a route's view, from what it held when it is made again (build).</summary>
    Slot Build(string route, object? saved = null)
    {
        if (!slots.TryGetValue(route, out var slot)) slots[route] = slot = new Slot();
        else Teardown(slot);
        slot.Key = KeyOf(route);
        slot.Part = Render(route, saved);
        if (slot.Part is { } part)
        {
            part.El.Visibility = route == active ? Visibility.Visible : Visibility.Collapsed;
            host.Children.Add(part.El);
        }
        slot.Fresh = true;
        slot.Focus = null;
        return slot;
    }

    void Teardown(Slot slot)
    {
        if (slot.Part is not { } part) return;
        part.Teardown();
        host.Children.Remove(part.El);
        slot.Part = null;
    }

    /// <summary>Lets go of a route's view; the part then goes back to its form (dropSlot).</summary>
    void DropSlot(string route)
    {
        if (slots.Remove(route, out var slot)) Teardown(slot);
        if (active == route) active = "";
    }

    Part? Render(string route, object? saved)
    {
        if (route == "")
        {
            formHasPlaces = App.Session is not null;
            return new FolderForm(this, saved as FolderRequest ?? form);
        }
        var job = JobFor(route);
        if (job is null) return null;
        return route == "done" ? RebuildView.Make(this, job) : ViewJob(job, saved);
    }

    /// <summary>What the plan's job needs: how it goes, why it ended, what it found (viewJob).</summary>
    Part ViewJob(Job job, object? saved)
    {
        var request = RequestOf(job);
        if (job.Running) return new Progress(job);
        if (job.State == "failed") return new Part(StatePage.Failed(job, () => Again(request), () => Go("", focus: true)), T["error.title"], job);
        if (job.State == "cancelled") return new Part(StatePage.Stopped(job, () => Again(request), () => Go("", focus: true)), T["progress.stopped.title"], job);
        if (!job.Complete) return new Part(StatePage.Loading(job, () => Retry(job)), ProgressView.JobTitle(job), job);
        if (!job.Items.Any((i) => i is not null)) return EmptyPlan.Make(this, job, request);
        return new PlanView(this, job, saved as PlanState);
    }

    /// <summary>How a plan goes, place by place: the shared view of a search under way.</summary>
    sealed class Progress : Part
    {
        readonly ProgressView view;

        public Progress(Job job) : base(new ProgressView(job), ProgressView.JobTitle(job), job) => view = (ProgressView)El;

        public override void Update() => view.Update();
    }

    FolderRequest RequestOf(Job job) => requests.TryGetValue(job.Id, out var r) ? r : FolderRequest.FromEcho(job.Request);

    /// <summary>
    /// Shows a route's view: the one kept when it is still the one to show, else a new one, at the
    /// top. `focus`: the person went there from inside the part, and the focus goes with them -- to
    /// where it was in a kept view, else to its heading, where a screen reader starts.
    /// </summary>
    void Show(string route, bool focus = false)
    {
        if (route != "" && JobFor(route) is null)
        {
            DropSlot(route);
            route = "";
        }
        active = route;
        if (!slots.TryGetValue(route, out var slot) || slot.Key != KeyOf(route) || slot.Part is null) slot = Build(route);
        else slot.Part.OnShow();
        ShowOnly(route);
        if (slot.Fresh)
        {
            slot.Fresh = false;
            slot.Part?.Scroller?.ScrollToTop();
            if (focus) FocusHeading(slot);
        }
        else if (focus)
        {
            if (slot.Focus is UIElement { IsVisible: true } was && slot.Part?.El.IsAncestorOf((DependencyObject)was) == true) Later(() => was.Focus());
            else FocusHeading(slot);
        }
        HeadingChanged?.Invoke();
    }

    void ShowOnly(string route)
    {
        foreach (var (r, s) in slots)
            if (s.Part is { } p) p.El.Visibility = r == route ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>Goes to another view of the part: "" the form, "plan", "done".</summary>
    public void Go(string route, bool focus = false)
    {
        if (IsVisible) Show(route, focus);
        else MainWindow.Navigate(route == "" ? "folder" : "folder/" + route);
    }

    /// <summary>The focus on a view's heading, without scrolling to it (the page's preventScroll).</summary>
    void FocusHeading(Slot slot) => Later(() =>
    {
        if (slot.Part?.HeadingBlock is not { } h) return;
        var scroller = slot.Part.Scroller;
        double y = scroller?.VerticalOffset ?? 0;
        h.Focusable = true;
        h.FocusVisualStyle = null;
        KeyboardNavigation.SetIsTabStop(h, false);
        Keyboard.Focus(h);
        scroller?.ScrollToVerticalOffset(y);
    });

    void Later(Action a) => Dispatcher.BeginInvoke(a, DispatcherPriority.Loaded);

    /// <summary>The form filled in with a folder to bring back, made again from what it held (prefill).</summary>
    void Prefill(string folder)
    {
        var now = slots.TryGetValue("", out var s) && s.Part is FolderForm f ? f.Values() : form;
        form = now with { Folder = folder };
        DropSlot("");
    }

    // ---- the engine's jobs -------------------------------------------------------------------------

    /// <summary>
    /// Starts a folder's plan, stopping the search already running when the person agrees: the
    /// engine runs one at a time. Started from elsewhere than the form -- Try again, Search again
    /// without the limits -- the form is made again from it, so that it says what was asked
    /// (startSearch). Then the plan is shown, and how it goes.
    /// </summary>
    public async Task StartPlanAsync(FolderRequest request, bool fromForm)
    {
        if (App.Session is not { } session) return;
        form = request;
        if (!fromForm) DropSlot("");
        var owner = Window.GetWindow(this) ?? Application.Current.MainWindow;
        var job = await session.Jobs.StartAsync("folder", request.Body(session),
            () => Dialog.ConfirmAsync(owner, T["progress.busy.title"], T["progress.busy.body"], T["progress.busy.ok"], T["common.cancel"]));
        if (job is null) return;
        requests[job.Id] = request;
        Go("plan", focus: true);
    }

    /// <summary>The plan again, as it was asked, or wider; what goes wrong is said at once.</summary>
    public async void Again(FolderRequest request)
    {
        try
        {
            await StartPlanAsync(request, fromForm: false);
        }
        catch (Exception e) when (e is CoreException or HttpRequestException)
        {
            Announce.Alert(Formats.ErrorText(e));
        }
    }

    /// <summary>A plan done, whose files are asked for again after that failed.</summary>
    void Retry(Job job)
    {
        job.LoadError = null;
        if (App.Session is { } s) _ = s.Jobs.FetchItemsAsync(job);
        OnChanged(job);
    }

    /// <summary>
    /// The dialog that asks where to write a plan's files; once it has started writing them, the
    /// writing is shown. `modal` false leaves it open for a picture of it.
    /// </summary>
    public void OpenRebuild(RebuildRequest request, bool modal)
    {
        if (App.Session is not { } session) return;
        var owner = Window.GetWindow(this) ?? Application.Current.MainWindow;
        var dialog = new RestoreDialog(owner, session, rebuild: request);
        if (modal)
        {
            dialog.ShowDialog();
            if (dialog.Started is not null) Go("done", focus: true);
            return;
        }
        dialog.Closed += (_, _) =>
        {
            if (dialog.Started is not null) Go("done", focus: true);
        };
        dialog.Show();
    }

    /// <summary>From the folder written back to its plan, while that is kept; else to the form.</summary>
    public void BackFromRebuild() => Go(App.Session?.Jobs.Current("folder") is not null ? "plan" : "", focus: true);

    /// <summary>
    /// A job has moved on -- ended, all its files here, let go of -- and every view that shows it
    /// follows, in sight or not: one whose job needs another kind of view now is made again, one
    /// whose job is gone goes, the rest only update (jobChanged).
    /// </summary>
    void OnChanged(Job job)
    {
        foreach (var route in new[] { "plan", "done" })
        {
            if (!slots.TryGetValue(route, out var slot)) continue;
            if (slot.Key == KeyOf(route))
            {
                if (slot.Part?.Job == job) slot.Part.Update();
                continue;
            }
            bool hadFocus = slot.Part?.El.IsKeyboardFocusWithin == true || (IsVisible && route == active && Keyboard.FocusedElement is null);
            if (route == active) Show(route, focus: hadFocus);
            else if (JobFor(route) is null) DropSlot(route);
            else Build(route);
        }
        if (slots.TryGetValue("", out var f)) f.Part?.Update();
        Said(job);
        HeadingChanged?.Invoke();
    }

    /// <summary>A plan or a folder written is said to be done, once, however far away the person is.</summary>
    void Said(Job job)
    {
        if (job.State != "done" || App.Session is not { } s) return;
        if (job.Kind == "plan" && s.Jobs.Current("folder") == job && announced.Add(job.Id))
            Announce.Say(T.Get("a11y.planDone", ("count", job.Total ?? 0)));
        else if (job.Kind == "rebuild" && s.Jobs.Current("rebuild") == job && announced.Add(job.Id))
            Announce.Say(T.Get("rebuild.done", ("written", Num(job.Said("written"))), ("count", Num(job.Said("files")))));
    }

    static long Num(System.Text.Json.JsonElement? v) => v is { ValueKind: System.Text.Json.JsonValueKind.Number } n ? (long)n.GetDouble() : 0;

    /// <summary>A job a step further: its views draw it again, and each place done is said while its plan is in sight.</summary>
    void OnProgressed(Job job)
    {
        foreach (var slot in slots.Values) if (slot.Part?.Job == job) slot.Part.Update();
        if (job.Kind != "plan") return;
        bool inSight = IsVisible && active == "plan" && App.Session?.Jobs.Current("folder") == job;
        foreach (var row in job.Rows)
        {
            var key = job.Id + "\n" + row.Id;
            bool ended = row.Status is "done" or "failed" or "skipped";
            bool was = rowStatus.TryGetValue(key, out var before) && before is "done" or "failed" or "skipped";
            rowStatus[key] = row.Status;
            if (ended && !was && inSight)
                Announce.Say(T.Get("a11y.sourceDone", ("source", Formats.SourceLabel(row.Id, row.Label)), ("result", ProgressView.RowResult(row))));
        }
    }

    // ---- another language ----------------------------------------------------------------------------

    /// <summary>
    /// Every view made again in the language now chosen, from what each held: the form, the plan's
    /// ticks, folders opened and filter. The one in sight stays in sight, where it was scrolled (rebuildAll).
    /// </summary>
    void RebuildAll()
    {
        double y = slots.TryGetValue(active, out var a) ? a.Part?.Scroller?.VerticalOffset ?? 0 : 0;
        bool hadFocus = IsKeyboardFocusWithin;
        foreach (var route in slots.Keys.ToList())
        {
            var saved = slots[route].Part?.Save();
            var slot = Build(route, saved);
            if (route == active) slot.Fresh = false;
        }
        ShowOnly(active);
        if (slots.TryGetValue(active, out var now))
        {
            if (hadFocus) FocusHeading(now);
            Later(() => now.Part?.Scroller?.ScrollToVerticalOffset(y));
        }
        HeadingChanged?.Invoke();
    }
}
