using System.Text.Json;

namespace Solarljos.Core;

/// <summary>One place searched, as a search's progress shows it: waiting, running, done, failed or skipped.</summary>
public sealed class SourceRow
{
    public string Id { get; init; } = "";
    public string Label { get; set; } = "";
    public string Status { get; set; } = "waiting";
    public long Done { get; set; }
    public long Total { get; set; }
    public long Count { get; set; }
    public string? Error { get; set; }
}

/// <summary>
/// The program's picture of one of the engine's jobs -- a search, a folder's plan, a folder being
/// written -- as the page keeps one (jobOf in src/gui/ui/app.js): made the first time either side
/// names it, filled in from what the engine says of it.
/// </summary>
public sealed class Job
{
    public string Id { get; init; } = "";
    public string Kind { get; set; } = "";
    /// <summary>The view it belongs to: "name", "media", "folder" or "rebuild".</summary>
    public string Mode { get; set; } = "";
    /// <summary>What was asked, as the engine echoes it (snapshot().request).</summary>
    public JsonElement Request { get; set; }
    public string State { get; set; } = "running";
    public List<SourceRow> Rows { get; } = new();
    public bool Filtering { get; set; }
    public double StartedAt { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public Dictionary<string, JsonElement> Summary { get; } = new();
    public string? Error { get; set; }
    /// <summary>Its results, or its plan's files, in order; null where one is still to come.</summary>
    public List<JsonElement?> Items { get; } = new();
    public int Received { get; set; }
    public int? Total { get; set; }
    public bool Complete { get; set; }
    public long Written { get; set; }
    public long WriteTotal { get; set; }
    public string Rel { get; set; } = "";
    /// <summary>The language the library spoke when it was made, which its notes are in.</summary>
    public string? Lang { get; set; }
    public Exception? LoadError { get; set; }
    internal Task? Fetching { get; set; }

    public bool Running => State == "running";

    public SourceRow Row(string id, string? label)
    {
        var row = Rows.FirstOrDefault((r) => r.Id == id);
        if (row is null)
        {
            row = new SourceRow { Id = id, Label = label ?? id };
            Rows.Add(row);
        }
        return row;
    }

    /// <summary>A field of what the engine said of it when it ended (perSource, stats, notes, ...).</summary>
    public JsonElement? Said(string key) => Summary.TryGetValue(key, out var v) ? v : null;

    /// <summary>The copies it found, those that have come so far.</summary>
    public IEnumerable<Copy> Copies() => Items.Where((i) => i is not null).Select((i) => Copy.From(i!.Value));
}

/// <summary>
/// Every job the engine has told of, and the one each view shows; what its event stream says,
/// applied to them (EVENTS in src/gui/ui/app.js). `Changed` says a job has moved on -- ended, its
/// results all here, let go of -- and `Progressed` that a search went a step further; both on the
/// window's thread.
/// </summary>
public sealed class JobStore
{
    static readonly string[] Modes = ["name", "media", "folder", "rebuild"];
    const int ItemsPage = 2000;

    readonly Session session;
    readonly Dictionary<string, Job> jobs = new();
    readonly Dictionary<string, string?> current = Modes.ToDictionary((m) => m, (_) => (string?)null);

    public event Action<Job>? Changed;
    public event Action<Job>? Progressed;
    public event Action<JsonElement>? RestoreProgress;

    public JobStore(Session session)
    {
        this.session = session;
        session.Event += OnEvent;
    }

    /// <summary>The job a view shows: its last search or plan.</summary>
    public Job? Current(string mode) => current.TryGetValue(mode, out var id) && id is not null && jobs.TryGetValue(id, out var j) ? j : null;

    public void SetCurrent(string mode, Job? job) => current[mode] = job?.Id;

    public Job JobOf(string id)
    {
        if (!jobs.TryGetValue(id, out var job)) jobs[id] = job = new Job { Id = id };
        return job;
    }

    /// <summary>Which view a job belongs to, from what the engine echoes of its request (modeOf in app.js).</summary>
    public static string ModeOf(JsonElement snap)
    {
        var kind = snap.TryGetProperty("kind", out var k) ? k.GetString() : null;
        if (kind == "plan") return "folder";
        if (kind == "rebuild") return "rebuild";
        if (snap.TryGetProperty("request", out var r) && r.ValueKind == JsonValueKind.Object)
        {
            if (r.TryGetProperty("view", out var v) && v.ValueKind == JsonValueKind.Object && v.TryGetProperty("mode", out var m)
                && m.GetString() is "name" or "media") return m.GetString()!;
            bool named = (r.TryGetProperty("pattern", out var p) && p.ValueKind == JsonValueKind.String && p.GetString() != "")
                || (r.TryGetProperty("containing", out var c) && c.ValueKind == JsonValueKind.String && c.GetString() != "");
            var types = r.TryGetProperty("types", out var t) && t.ValueKind == JsonValueKind.Array ? t.EnumerateArray().Select((x) => x.GetString()).ToList() : [];
            if (!named && types.Count > 0 && types.All((x) => x is "image" or "video")) return "media";
        }
        return "name";
    }

    /// <summary>Takes in what the engine says of a job: as it answers a request, in hello, and when the job ends.</summary>
    public Job Adopt(JsonElement snap)
    {
        var job = JobOf(snap.GetProperty("id").ToString());
        // A job that has ended stays ended: the reply that started it can come after the event that
        // said it ended, when it ended at once, and says it is running.
        if (!job.Running && snap.TryGetProperty("state", out var said) && said.GetString() == "running") return job;
        if (snap.TryGetProperty("kind", out var kind) && kind.GetString() is { } k) job.Kind = k;
        if (job.Mode == "") job.Mode = ModeOf(snap);
        if (snap.TryGetProperty("request", out var req)) job.Request = req.Clone();
        if (snap.TryGetProperty("state", out var st) && st.GetString() is { } s) job.State = s;
        if (snap.TryGetProperty("startedAt", out var at) && at.ValueKind == JsonValueKind.Number) job.StartedAt = at.GetDouble();
        job.Error = snap.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
        if (snap.TryGetProperty("lang", out var l) && l.ValueKind == JsonValueKind.String) job.Lang = l.GetString();
        if (snap.TryGetProperty("sources", out var sources) && sources.ValueKind == JsonValueKind.Array)
        {
            foreach (var src in sources.EnumerateArray())
            {
                var label = src.TryGetProperty("label", out var lb) ? lb.GetString() : null;
                var row = job.Row(src.GetProperty("id").GetString()!, label);
                if (label is not null) row.Label = label;
                if (src.TryGetProperty("state", out var rs) && rs.GetString() is { } rstate) row.Status = rstate;
                if (src.TryGetProperty("done", out var d) && d.ValueKind == JsonValueKind.Number) row.Done = d.GetInt64();
                if (src.TryGetProperty("total", out var tt) && tt.ValueKind == JsonValueKind.Number) row.Total = tt.GetInt64();
                if (src.TryGetProperty("count", out var c) && c.ValueKind == JsonValueKind.Number) row.Count = c.GetInt64();
                row.Error = src.TryGetProperty("error", out var re) && re.ValueKind == JsonValueKind.String ? re.GetString() : null;
            }
        }
        foreach (var p in snap.EnumerateObject())
        {
            if (p.Name is "id" or "kind" or "state" or "request" or "startedAt" or "finishedAt" or "error" or "sources" or "total" or "lang") continue;
            job.Summary[p.Name] = p.Value.Clone();
        }
        if (snap.TryGetProperty("total", out var total) && total.ValueKind == JsonValueKind.Number && job.Kind != "rebuild") job.Total = total.GetInt32();
        CheckComplete(job);
        return job;
    }

    void OnEvent(string name, JsonElement d)
    {
        switch (name)
        {
            case "hello":
                {
                    var kept = new HashSet<string>();
                    if (d.TryGetProperty("jobs", out var list))
                    {
                        foreach (var snap in list.EnumerateArray())
                        {
                            var job = Adopt(snap);
                            kept.Add(job.Id);
                            if (job.State == "done" && job.Kind is "search" or "plan" && !job.Complete) _ = FetchItemsAsync(job);
                        }
                    }
                    foreach (var job in jobs.Values.Where((j) => !kept.Contains(j.Id)).ToList()) Forget(job);
                    foreach (var job in jobs.Values.ToList()) Changed?.Invoke(job);
                    break;
                }
            case "progress":
                {
                    var job = JobOf(d.GetProperty("job").ToString());
                    ApplyProgress(job, d);
                    Progressed?.Invoke(job);
                    break;
                }
            case "results":
            case "plan":
                Take(JobOf(d.GetProperty("job").ToString()), d);
                break;
            case "done":
            case "failed":
            case "cancelled":
                Finished(d);
                break;
            case "restore-progress":
                RestoreProgress?.Invoke(d);
                break;
        }
    }

    static void ApplyProgress(Job job, JsonElement e)
    {
        var type = e.TryGetProperty("type", out var t) ? t.GetString() : null;
        if (type == "writing")
        {
            job.Written = e.TryGetProperty("done", out var done) && done.ValueKind == JsonValueKind.Number ? done.GetInt64() : 0;
            if (e.TryGetProperty("total", out var tot) && tot.ValueKind == JsonValueKind.Number) job.WriteTotal = tot.GetInt64();
            if (e.TryGetProperty("rel", out var rel) && rel.GetString() is { } r) job.Rel = r;
            return;
        }
        if (type == "filtering")
        {
            job.Filtering = true;
            return;
        }
        if (!e.TryGetProperty("id", out var idv) || idv.ValueKind != JsonValueKind.String) return;
        var label = e.TryGetProperty("label", out var l) ? l.GetString() : null;
        var row = job.Row(idv.GetString()!, label);
        if (label is not null) row.Label = label;
        switch (type)
        {
            case "source-start":
                row.Status = "running";
                break;
            case "source-progress":
                row.Status = "running";
                row.Done = e.TryGetProperty("done", out var dn) && dn.ValueKind == JsonValueKind.Number ? dn.GetInt64() : row.Done;
                row.Total = e.TryGetProperty("total", out var tt) && tt.ValueKind == JsonValueKind.Number ? tt.GetInt64() : row.Total;
                break;
            case "source-done":
                row.Error = e.TryGetProperty("error", out var er) && er.ValueKind == JsonValueKind.String ? er.GetString() : null;
                bool skipped = e.TryGetProperty("skipped", out var sk) && sk.ValueKind == JsonValueKind.True;
                row.Status = row.Error is not null ? "failed" : skipped ? "skipped" : "done";
                row.Count = e.TryGetProperty("count", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetInt64() : 0;
                break;
        }
    }

    void Take(Job job, JsonElement d)
    {
        if (d.TryGetProperty("total", out var t) && t.ValueKind == JsonValueKind.Number) job.Total = t.GetInt32();
        int at = d.TryGetProperty("offset", out var o) && o.ValueKind == JsonValueKind.Number ? o.GetInt32() : 0;
        if (d.TryGetProperty("items", out var items))
        {
            int i = 0;
            foreach (var it in items.EnumerateArray())
            {
                int k = at + i++;
                while (job.Items.Count <= k) job.Items.Add(null);
                if (job.Items[k] is null) job.Received++;
                job.Items[k] = it.Clone();
            }
        }
        bool was = job.Complete;
        CheckComplete(job);
        if (!was && job.Complete) Changed?.Invoke(job);
    }

    static void CheckComplete(Job job) => job.Complete = job.State == "done" && job.Total is { } t && job.Received >= t;

    /// <summary>Asks for the results the stream did not bring: past the first ones, or when it dropped some.</summary>
    public Task FetchItemsAsync(Job job)
    {
        if (job.Fetching is { } running) return running;
        job.Fetching = Run();
        return job.Fetching;

        async Task Run()
        {
            try
            {
                int offset = 0;
                while (!job.Complete)
                {
                    while (offset < job.Items.Count && job.Items[offset] is not null && offset < (job.Total ?? 0)) offset++;
                    var d = await session.Client.GetAsync($"/api/job/{Uri.EscapeDataString(job.Id)}/items?offset={offset}&limit={ItemsPage}");
                    int before = job.Received;
                    Take(job, d);
                    if (!d.TryGetProperty("items", out var items) || items.GetArrayLength() == 0) break;
                    offset += items.GetArrayLength();
                    if (job.Received == before) break;
                }
            }
            catch (CoreException e)
            {
                job.LoadError = e;
                if (e.Status == 404) Forget(job);
            }
            catch (HttpRequestException e)
            {
                job.LoadError = e;
            }
            finally
            {
                job.Fetching = null;
                Changed?.Invoke(job);
            }
        }
    }

    void Forget(Job job)
    {
        jobs.Remove(job.Id);
        foreach (var m in Modes) if (current[m] == job.Id) current[m] = null;
        Changed?.Invoke(job);
    }

    /// <summary>The engine keeps one finished search per view and one finished plan; so does the program.</summary>
    void DropOlder(Job job)
    {
        if (job.Kind is not ("search" or "plan")) return;
        foreach (var other in jobs.Values.Where((o) => o != job && o.Kind == job.Kind && o.Mode == job.Mode && !o.Running).ToList()) Forget(other);
    }

    void Finished(JsonElement snap)
    {
        var job = Adopt(snap);
        DropOlder(job);
        if (job.State == "done" && job.Kind is "search" or "plan" && !job.Complete) _ = FetchItemsAsync(job);
        Changed?.Invoke(job);
    }

    /// <summary>
    /// Starts a search, or a folder's plan (mode "folder"), with what is sent as it is; when one is
    /// already running `stopFirst` is asked whether to stop it, and the engine runs one at a time.
    /// Null when it was not started.
    /// </summary>
    public async Task<Job?> StartAsync(string mode, object body, Func<Task<bool>> stopFirst)
    {
        var url = mode == "folder" ? "/api/plan" : "/api/search";
        JsonElement res;
        try
        {
            res = await session.Client.PostAsync(url, body);
        }
        catch (CoreException e) when (e.Status == 409 && e.Body.ValueKind == JsonValueKind.Object && e.Body.TryGetProperty("job", out var busy))
        {
            if (!await stopFirst()) return null;
            await session.Client.PostAsync("/api/cancel", new { job = busy.ToString() });
            res = await session.Client.PostAsync(url, body);
        }
        var job = Adopt(res.GetProperty("job"));
        job.Mode = mode;
        SetCurrent(mode, job);
        Changed?.Invoke(job);
        return job;
    }

    /// <summary>Starts writing a folder from its plan.</summary>
    public async Task<Job> RebuildAsync(object body)
    {
        var res = await session.Client.PostAsync("/api/rebuild", body);
        var job = Adopt(res.GetProperty("job"));
        job.Mode = "rebuild";
        SetCurrent("rebuild", job);
        Changed?.Invoke(job);
        return job;
    }

    /// <summary>Stops a search or a plan; it is answered as stopped at once.</summary>
    public async Task StopAsync(Job job)
    {
        var res = await session.Client.PostAsync("/api/cancel", new { job = job.Id });
        if (res.ValueKind == JsonValueKind.Object && res.TryGetProperty("job", out var snap)) Finished(snap);
    }
}
