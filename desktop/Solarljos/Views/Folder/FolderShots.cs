using System.Text.Json;
using System.Windows.Controls;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Views.Folder;

namespace Solarljos.Views;

/// <summary>
/// What the part does before a picture of it (Dev/Shot.cs), on the made-up engine: acts by name,
/// several joined by "|". "plan:C:\Users\you\Documents\thesis" fills in the form and waits for the
/// plan; "untick", "leftout", "rebuild" (its dialog left open), "done" (written, and what came of
/// it) start from that plan when there is none yet. "planning", "writing", "failed", "stopped" and
/// "empty" show a made-up job that stands so, which the made-up engine has no way to make.
/// "keys:Down,Right,Space,..." presses keys in the plan's tree, as the keyboard sends them;
/// "lang:ja" changes the language, as the rail's list does. "form:...", "more", "errors",
/// "fill:...", "filter:...", "scroll:N", "end" and "back" are steps of their own. The keyboard's
/// ring is drawn wherever the focus is, since no key is pressed for a picture.
/// </summary>
public sealed partial class FolderView
{
    const string Thesis = @"C:\Users\you\Documents\thesis";

    public async Task ActAsync(string act)
    {
        // The event stream's hello first: it lets go of every job the engine did not have when it was sent.
        await Task.Delay(1500);
        foreach (var step in act.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            await StepAsync(step);
        await Task.Delay(200);
    }

    async Task StepAsync(string step)
    {
        PlanTreeItem.KeepRing = true;
        var (name, arg) = step.IndexOf(':') is var at and > 0 ? (step[..at], step[(at + 1)..]) : (step, "");
        switch (name)
        {
            case "form":
                Show("");
                (slots[""].Part as FolderForm)?.Type(arg.Length > 0 ? arg : Thesis);
                break;
            case "more":
                (slots.GetValueOrDefault("")?.Part as FolderForm)?.OpenMore();
                break;
            case "errors":
                Show("");
                if (slots[""].Part is FolderForm bad)
                {
                    bad.Type(@"Documents\thesis");
                    bad.TypeSince("2026-02-30");
                    await bad.SendAsync();
                }
                break;
            case "fill":
                Shown("fill:" + (arg.Length > 0 ? arg : Thesis));
                break;
            case "plan":
                await PlanAsync(arg.Length > 0 ? arg : Thesis);
                break;
            case "back":
                Show("", focus: true);
                break;
            case "untick":
                await EnsurePlanAsync();
                if (Plan() is { } p)
                {
                    p.Open("chapters");
                    p.Untick("data");
                    p.Untick("notes.txt");
                    p.Untick("chapters/04-discussion.md");
                    await Task.Delay(100);
                    p.FocusRow("chapters/02-methods.md");
                }
                break;
            case "leftout":
                await EnsurePlanAsync();
                if (Plan() is { } l)
                {
                    l.TickLeftOut("figures/fig-6.png");
                    await Task.Delay(100);
                    l.ScrollToEnd();
                }
                break;
            case "filter":
                await EnsurePlanAsync();
                if (Plan()?.El is ScrollViewer sv)
                {
                    foreach (var box in Descend<ComboBox>(sv)) box.SelectedValue = arg;
                }
                break;
            case "rebuild":
                await EnsurePlanAsync();
                if (Plan() is { } r) OpenRebuild(r.Request(), modal: false);
                await Task.Delay(1500);
                break;
            case "done":
                await EnsurePlanAsync();
                if (Plan() is { } d && App.Session is { } s)
                {
                    var req = d.Request();
                    var to = @"D:\Solarljos recovered\" + Formats.Stamp(DateTimeOffset.Now);
                    await s.Jobs.RebuildAsync(new { plan = req.Plan.Id, to, exclude = req.Exclude, include = req.Include });
                    Show("done");
                    await WaitAsync(() => s.Jobs.Current("rebuild") is { Running: false });
                    Show("done");
                }
                break;
            case "planning":
                await MadeAsync("planning", "plan", "folder", "running", (j) =>
                {
                    j.StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 12_000;
                    var labels = App.Session?.Sources.ToList() ?? [];
                    for (int i = 0; i < labels.Count; i++)
                    {
                        var row = j.Row(labels[i].Id, labels[i].Label);
                        row.Status = i < 5 ? "done" : i == 5 ? "running" : "waiting";
                        row.Count = i < 5 ? i % 3 : 0;
                        if (i == 5)
                        {
                            row.Done = 412;
                            row.Total = 1906;
                        }
                    }
                });
                Show("plan");
                break;
            case "failed":
                await MadeAsync("failed", "plan", "folder", "failed", (j) => j.Error = "The shadow copies could not be listed: EACCES: permission denied");
                Show("plan");
                break;
            case "stopped":
                await MadeAsync("stopped", "plan", "folder", "cancelled", (_) => { });
                Show("plan");
                break;
            case "empty":
                await MadeAsync("empty", "plan", "folder", "done", (j) =>
                {
                    j.Total = 0;
                    j.Complete = true;
                    j.Summary["folder"] = Json($"\"{Thesis.Replace(@"\", @"\\")}\"");
                    var ids = App.Session?.Sources.Select((x) => x.Id).ToList() ?? [];
                    j.Summary["perSource"] = Json("[" + string.Join(",", ids.Select((id) => id == "jetbrains"
                        ? $"{{\"id\":\"{id}\",\"count\":0,\"error\":\"EBUSY: resource busy or locked\"}}"
                        : $"{{\"id\":\"{id}\",\"count\":0}}")) + "]");
                }, deletedOnly: true);
                Show("plan");
                break;
            case "writing":
                await MadeAsync("writing", "rebuild", "rebuild", "running", (j) =>
                {
                    j.Written = 7;
                    j.WriteTotal = 17;
                    j.Rel = "chapters/02-methods.md";
                });
                Show("done");
                break;
            case "keys":
                await EnsurePlanAsync();
                if (Plan() is { } k)
                {
                    var keys = arg.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                        .Select((x) => Enum.TryParse<System.Windows.Input.Key>(x, out var key) ? key : System.Windows.Input.Key.None)
                        .Where((x) => x != System.Windows.Input.Key.None);
                    await k.PressAsync(keys);
                }
                break;
            case "lang":
                // Another language, as the rail's list chooses it: every view is made again from what it held.
                Tr.Instance.Use(arg);
                Ui.Theme.UseFontFor(Tr.Instance.Code);
                if (App.Session is { } ls) await ls.UseLanguageAsync(Tr.Instance.Code);
                break;
            case "scroll":
                if (slots.GetValueOrDefault(active)?.Part?.Scroller is { } sc && double.TryParse(arg, out var y)) sc.ScrollToVerticalOffset(y);
                break;
            case "end":
                slots.GetValueOrDefault(active)?.Part?.Scroller?.ScrollToEnd();
                break;
        }
        await Task.Delay(150);
    }

    PlanView? Plan() => slots.GetValueOrDefault("plan")?.Part as PlanView;

    async Task EnsurePlanAsync()
    {
        if (Plan() is null) await PlanAsync(Thesis);
    }

    async Task PlanAsync(string folder)
    {
        Show("");
        if (slots[""].Part is not FolderForm f) return;
        f.Type(folder);
        await f.SendAsync();
        await WaitAsync(() => App.Session?.Jobs.Current("folder") is { Running: false, Complete: true } || App.Session?.Jobs.Current("folder") is { State: "failed" or "cancelled" });
        await Task.Delay(100);
        Show("plan");
    }

    static async Task WaitAsync(Func<bool> done)
    {
        for (int i = 0; i < 400 && !done(); i++) await Task.Delay(50);
    }

    /// <summary>A job of the engine's kind and standing, made up for a picture: the engine is not asked of it.</summary>
    async Task MadeAsync(string id, string kind, string mode, string state, Action<Job> fill, bool deletedOnly = false)
    {
        await Task.Yield();
        if (App.Session is not { } s) return;
        var job = s.Jobs.JobOf("shot-" + id);
        job.Kind = kind;
        job.Mode = mode;
        job.State = state;
        job.Request = Json($"{{\"folder\":\"{Thesis.Replace(@"\", @"\\")}\",\"deletedOnly\":{(deletedOnly ? "true" : "false")},\"since\":null,\"sources\":null,\"files\":17}}");
        fill(job);
        s.Jobs.SetCurrent(mode, job);
        OnChanged(job);
    }

    static JsonElement Json(string text)
    {
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.Clone();
    }

    static IEnumerable<T> Descend<T>(System.Windows.DependencyObject root) where T : System.Windows.DependencyObject
    {
        int n = System.Windows.Media.VisualTreeHelper.GetChildrenCount(root);
        for (int i = 0; i < n; i++)
        {
            var c = System.Windows.Media.VisualTreeHelper.GetChild(root, i);
            if (c is T t) yield return t;
            foreach (var d in Descend<T>(c)) yield return d;
        }
    }
}
