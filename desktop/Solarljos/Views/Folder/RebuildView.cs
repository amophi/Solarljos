using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Windows.Documents;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Shared;

namespace Solarljos.Views.Folder;

/// <summary>
/// A folder being written, and then what came of it (viewRebuild in src/gui/ui/app.js): how far
/// it is, and the file being written; then how many came back, where they were written -- the
/// path, with a way to copy it, since the program opens no folder itself -- what could not be
/// read or written, and what kinds of copy the files came from.
/// </summary>
static class RebuildView
{
    static Tr T => Tr.Instance;

    static string? S(JsonElement? o, string k) => o is { ValueKind: JsonValueKind.Object } v && v.TryGetProperty(k, out var x) && x.ValueKind == JsonValueKind.String ? x.GetString() : null;
    static long L(JsonElement? v) => v is { ValueKind: JsonValueKind.Number } n ? (long)n.GetDouble() : 0;

    public static Part Make(FolderView owner, Job job)
    {
        if (job.State is "failed" or "cancelled")
        {
            var page = StatePage.Make("error", T["error.title"],
                Build.Text(job.Error is not null ? T.Get("rebuild.failedBecause", ("message", job.Error)) : T["error.unexpected"], "Lead").Margin(0, 12, 0, 0),
                StatePage.Actions(Build.Button(T["rebuild.back"], owner.BackFromRebuild, "BtnPrimary")));
            return new Part(Build.Page(page, 880), T["error.title"], job);
        }
        if (job.Running) return new Writing(job);
        return Done(owner, job);
    }

    /// <summary>How far the writing is: so many of so many, and the file being written.</summary>
    sealed class Writing : Part
    {
        readonly TextBlock status = Build.Text("", "Body");
        readonly ProgressBar bar = new() { Height = 6, Minimum = 0, Maximum = 1, Margin = new Thickness(0, 12, 0, 0) };
        readonly TextBlock line = Bits.PathText("", 13);
        string said = "";

        public Writing(Job job)
        {
            Job = job;
            Heading = T["rebuild.writing"];
            status.FontWeight = FontWeights.SemiBold;
            status.Margin = new Thickness(0, 0, 0, 0);
            AutomationProperties.SetLiveSetting(status, AutomationLiveSetting.Polite);
            bar.SetResourceReference(Control.ForegroundProperty, "Accent");
            bar.SetResourceReference(Control.BackgroundProperty, "Track");
            bar.BorderThickness = new Thickness(0);
            line.Margin = new Thickness(0, 8, 0, 0);
            var head = Build.Heading(Heading);
            head.Margin = new Thickness(0, 8, 0, 24);
            El = Build.Page(Build.Stack(head, status, bar, line));
            Update();
        }

        public override void Update()
        {
            var job = Job!;
            long total = job.WriteTotal > 0 ? job.WriteTotal : L(job.Request.ValueKind == JsonValueKind.Object && job.Request.TryGetProperty("files", out var f) ? f : null);
            if (total > 0)
            {
                bar.IsIndeterminate = false;
                bar.Maximum = total;
                bar.Value = job.Written;
                status.Text = T.Get("rebuild.progress", ("done", job.Written), ("total", total));
            }
            else
            {
                bar.IsIndeterminate = true;
                status.Text = T["rebuild.progressUnknown"];
            }
            AutomationProperties.SetName(bar, status.Text);
            line.Text = job.Rel;
            if (said != status.Text && AutomationPeer.ListenerExists(AutomationEvents.LiveRegionChanged))
            {
                said = status.Text;
                (UIElementAutomationPeer.FromElement(status) ?? UIElementAutomationPeer.CreatePeerForElement(status))?.RaiseAutomationEvent(AutomationEvents.LiveRegionChanged);
            }
        }
    }

    static Part Done(FolderView owner, Job job)
    {
        long written = L(job.Said("written")), files = L(job.Said("files"));
        var root = job.Said("root") is { ValueKind: JsonValueKind.String } r ? r.GetString() : null;
        var failed = job.Said("failed") is { ValueKind: JsonValueKind.Array } fl ? fl.EnumerateArray().ToList() : [];
        var byKind = job.Said("byKind") is { ValueKind: JsonValueKind.Array } bk ? bk.EnumerateArray().ToList() : [];
        var title = T.Get("rebuild.done", ("written", written), ("count", files));
        var body = new List<UIElement?>();

        if (!string.IsNullOrEmpty(root))
        {
            var into = Build.Text(T["rebuild.into"], "Body");
            into.FontWeight = FontWeights.Bold;
            into.Margin = new Thickness(0, 16, 0, 4);
            var path = Build.PathBox(root);
            path.IsReadOnly = true;
            path.FontWeight = FontWeights.SemiBold;
            path.MinWidth = 280;
            path.HorizontalAlignment = HorizontalAlignment.Left;
            AutomationProperties.SetName(path, T["rebuild.into"]);
            AutomationProperties.SetLabeledBy(path, into);
            Button? copy = null;
            copy = Bits.Small(T["common.copyPath"], () =>
            {
                try
                {
                    Clipboard.SetText(root);
                    copy!.Content = T["common.copied"];
                    Announce.Say(T["common.copied"]);
                }
                catch (System.Runtime.InteropServices.ExternalException)
                {
                    Announce.Alert(T["common.copyFailed"]);
                }
            });
            copy.VerticalAlignment = VerticalAlignment.Center;
            var row = new WrapPanel();
            path.Margin = new Thickness(0, 0, 12, 8);
            copy.Margin = new Thickness(0, 0, 0, 8);
            row.Children.Add(path);
            row.Children.Add(copy);
            body.Add(into);
            body.Add(row);
            body.Add(Build.Text(T["restore.openWarning"], "Hint").Margin(0, 0, 0, 8));
        }
        if (failed.Count > 0)
        {
            var lines = failed.Select((f) =>
            {
                var rel = string.Join('/', Paths.RelParts(S(f, "rel") ?? S(f, "path") ?? ""));
                var why = Formats.ErrorText(new CoreException(0, S(f, "error") ?? "", null, default));
                var t = Build.Text("", "Body");
                t.Margin = new Thickness(0, 4, 0, 0);
                t.Inlines.Add(new Run("• "));
                t.Inlines.Add(new Run(rel) { FlowDirection = FlowDirection.LeftToRight, FontFamily = Bits.Mono, FontSize = 13 });
                t.Inlines.Add(new Run(": " + why));
                return (UIElement)t;
            }).ToArray();
            body.Add(Build.Callout("warn", T.Get("rebuild.failed", ("count", failed.Count)), lines));
        }
        if (byKind.Count > 0)
        {
            var list = new StackPanel();
            for (int i = 0; i < byKind.Count; i++)
            {
                var k = byKind[i];
                var label = Build.Text(Formats.KindLabel(S(k, "kind") ?? "", S(k, "label")), "Body");
                var count = Build.Text(Tr.Instance.Number(L(k.TryGetProperty("count", out var c) ? c : null)), "Body");
                var line = new DockPanel();
                DockPanel.SetDock(count, Dock.Right);
                count.Margin = new Thickness(16, 0, 0, 0);
                line.Children.Add(count);
                line.Children.Add(label);
                var cell = new Border { Child = line, Padding = new Thickness(0, 8, 0, 8), BorderThickness = new Thickness(0, 0, 0, i < byKind.Count - 1 ? 1 : 0) };
                cell.SetResourceReference(Border.BorderBrushProperty, "Divider");
                AutomationProperties.SetName(cell, label.Text + ": " + count.Text);
                list.Children.Add(cell);
            }
            var panel = Bits.Panel(T["rebuild.byKind"], list);
            panel.Margin = new Thickness(0, 16, 0, 0);
            panel.MaxWidth = 512;
            panel.HorizontalAlignment = HorizontalAlignment.Left;
            body.Add(panel);
        }
        body.Add(StatePage.Actions(
            Build.Button(T["common.newSearch"], () => owner.Go("", focus: true), "BtnPrimary"),
            Build.Button(T["rebuild.back"], owner.BackFromRebuild)).Margin(0, 24, 0, 0));
        var kind = failed.Count > 0 && written == 0 ? "error" : "success";
        return new Part(Build.Page(StatePage.Make(kind, title, body.ToArray()), 880), title, job);
    }
}
