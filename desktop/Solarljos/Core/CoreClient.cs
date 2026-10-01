using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Solarljos.Core;

/// <summary>
/// The engine's API (listed at the top of src/gui/server.js), as the page asks it, over
/// 127.0.0.1 with the run's key: GETs and JSON POSTs, and the event stream. No proxy is ever
/// asked, and no cookie kept.
/// </summary>
public sealed class CoreClient : IDisposable
{
    readonly HttpClient http;
    readonly string key;

    public Uri Origin { get; }

    public CoreClient(int port, string key)
    {
        this.key = key;
        Origin = new Uri($"http://127.0.0.1:{port}");
        http = new HttpClient(new SocketsHttpHandler { UseProxy = false, UseCookies = false, AutomaticDecompression = DecompressionMethods.None })
        {
            BaseAddress = Origin,
            // A search runs on through the event stream; a request itself answers soon.
            Timeout = TimeSpan.FromMinutes(5),
        };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", key);
    }

    /// <summary>A copy's bytes by address, for what asks by address alone: Windows' media player.</summary>
    public Uri CopyUri(string uid) => new(Origin, $"/api/copy/{Uri.EscapeDataString(uid)}?key={Uri.EscapeDataString(key)}");

    public async Task<JsonElement> GetAsync(string path, CancellationToken cancel = default)
    {
        using var res = await http.GetAsync(path, cancel);
        return await ReadAsync(res, cancel);
    }

    public async Task<byte[]> GetBytesAsync(string path, CancellationToken cancel = default)
    {
        using var res = await http.GetAsync(path, cancel);
        if (!res.IsSuccessStatusCode) throw await FailureAsync(res, cancel);
        return await res.Content.ReadAsByteArrayAsync(cancel);
    }

    /// <summary>
    /// Bytes `start` to `start + length - 1` of a copy, fewer where it ends; none past its end. A
    /// copy whose length the engine does not know comes whole, so only what is wanted is kept.
    /// </summary>
    public async Task<byte[]> ReadBytesAsync(string uid, long start, int length, CancellationToken cancel = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/copy/{Uri.EscapeDataString(uid)}");
        req.Headers.Range = new RangeHeaderValue(start, start + length - 1);
        using var res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cancel);
        if ((int)res.StatusCode == 416) return [];
        if (!res.IsSuccessStatusCode) throw await FailureAsync(res, cancel);
        await using var stream = await res.Content.ReadAsStreamAsync(cancel);
        var out_ = new byte[length];
        int got = 0;
        long skip = res.StatusCode == HttpStatusCode.PartialContent ? 0 : start;
        var buf = new byte[81920];
        while (got < length)
        {
            int n = await stream.ReadAsync(buf, cancel);
            if (n == 0) break;
            int from = 0;
            if (skip > 0)
            {
                int s = (int)Math.Min(skip, n);
                skip -= s;
                from = s;
            }
            int take = Math.Min(n - from, length - got);
            if (take > 0)
            {
                Array.Copy(buf, from, out_, got, take);
                got += take;
            }
        }
        return got == length ? out_ : out_[..got];
    }

    /// <summary>What a copy's first bytes say it is, and how the engine sends it (GET copy/&lt;uid&gt;/about).</summary>
    public Task<JsonElement> AboutAsync(string uid, CancellationToken cancel = default) =>
        GetAsync($"/api/copy/{Uri.EscapeDataString(uid)}/about", cancel);

    /// <summary>A POST of JSON, as the page sends one: from this origin, saying it is Solarljos's.</summary>
    public async Task<JsonElement> PostAsync(string path, object body, CancellationToken cancel = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", Origin.GetLeftPart(UriPartial.Authority));
        req.Headers.Add("X-Solarljos", "1");
        using var res = await http.SendAsync(req, cancel);
        return await ReadAsync(res, cancel);
    }

    static async Task<JsonElement> ReadAsync(HttpResponseMessage res, CancellationToken cancel)
    {
        if (!res.IsSuccessStatusCode) throw await FailureAsync(res, cancel);
        var text = await res.Content.ReadAsStringAsync(cancel);
        if (text.Length == 0) return default;
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.Clone();
    }

    static async Task<CoreException> FailureAsync(HttpResponseMessage res, CancellationToken cancel)
    {
        string? error = null;
        string? code = null;
        JsonElement body = default;
        try
        {
            var text = await res.Content.ReadAsStringAsync(cancel);
            using var doc = JsonDocument.Parse(text);
            body = doc.RootElement.Clone();
            if (body.TryGetProperty("error", out var e)) error = e.GetString();
            if (body.TryGetProperty("code", out var c)) code = c.GetString();
        }
        catch (JsonException)
        {
        }
        return new CoreException((int)res.StatusCode, error ?? res.ReasonPhrase ?? "", code, body);
    }

    /// <summary>
    /// Reads the event stream until `cancel`: each event by name with its data. When the stream
    /// breaks it is opened again after a moment, as a browser's EventSource does; `onGone` is told
    /// each time.
    /// </summary>
    public async Task ListenAsync(Action<string, JsonElement> onEvent, Action<Exception> onGone, CancellationToken cancel)
    {
        while (!cancel.IsCancellationRequested)
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, "/api/events");
                req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
                using var res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cancel);
                res.EnsureSuccessStatusCode();
                await using var stream = await res.Content.ReadAsStreamAsync(cancel);
                using var reader = new StreamReader(stream, Encoding.UTF8);
                string name = "message";
                var data = new StringBuilder();
                while (!cancel.IsCancellationRequested)
                {
                    var line = await reader.ReadLineAsync(cancel);
                    if (line is null) break;
                    if (line.Length == 0)
                    {
                        if (data.Length > 0)
                        {
                            using var doc = JsonDocument.Parse(data.ToString());
                            onEvent(name, doc.RootElement.Clone());
                        }
                        name = "message";
                        data.Clear();
                        continue;
                    }
                    if (line.StartsWith(':')) continue;
                    if (line.StartsWith("event:")) name = line[6..].Trim();
                    else if (line.StartsWith("data:"))
                    {
                        if (data.Length > 0) data.Append('\n');
                        data.Append(line[5..].TrimStart());
                    }
                }
            }
            catch (OperationCanceledException) when (cancel.IsCancellationRequested)
            {
                return;
            }
            catch (Exception e) when (e is HttpRequestException or IOException or JsonException)
            {
                onGone(e);
            }
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(2), cancel);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    public void Dispose() => http.Dispose();
}

/// <summary>An answer of the engine's that is not a success: its status, and what it said went wrong.</summary>
public sealed class CoreException(int status, string message, string? code, JsonElement body) : Exception(message)
{
    public int Status { get; } = status;
    public string? Code { get; } = code;
    public JsonElement Body { get; } = body;
}
