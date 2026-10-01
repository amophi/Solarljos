using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Solarljos.Core;

/// <summary>
/// The engine: solarljos-core.exe beside this program, started as "desktop" (src/cli.js), which
/// prints one line of JSON -- its port and the key every request carries -- and stops once its
/// stdin closes. That is how it stops with this program however this one ends: closing the pipe
/// is the one thing a crash still does. What it says meanwhile goes to its stderr, kept here, the
/// last of it, for when it stops by itself.
///
/// SOLARLJOS_CORE, when set, is the command to run instead -- node "...\bin\solarljos.js", say --
/// for working on the program from the repository.
/// </summary>
public sealed class CoreProcess : IAsyncDisposable
{
    public const string FileName = "solarljos-core.exe";
    const int SaidKept = 40;

    readonly Process process;
    readonly LinkedList<string> said = new();

    public int Port { get; }
    public string Key { get; }
    public string Version { get; }

    /// <summary>Set when the engine has stopped, by itself or not.</summary>
    public Task Exited { get; }

    CoreProcess(Process process, int port, string key, string version, Task exited)
    {
        this.process = process;
        Port = port;
        Key = key;
        Version = version;
        Exited = exited;
    }

    /// <summary>What the engine said last, on stderr.</summary>
    public string LastSaid()
    {
        lock (said) return string.Join(Environment.NewLine, said);
    }

    /// <summary>The command that starts the engine: the file, and the arguments before "desktop".</summary>
    public static (string File, string[] Args)? Command()
    {
        var custom = Environment.GetEnvironmentVariable("SOLARLJOS_CORE");
        if (!string.IsNullOrWhiteSpace(custom)) return Split(custom);
        var beside = Path.Combine(AppContext.BaseDirectory, FileName);
        return File.Exists(beside) ? (beside, Array.Empty<string>()) : null;
    }

    /// <summary>A command line split as Windows splits one for a program: by spaces, "quoted" parts whole.</summary>
    static (string, string[]) Split(string line)
    {
        var parts = new List<string>();
        var cur = new StringBuilder();
        bool quoted = false, any = false;
        foreach (char ch in line)
        {
            if (ch == '"') { quoted = !quoted; any = true; continue; }
            if (char.IsWhiteSpace(ch) && !quoted)
            {
                if (any) parts.Add(cur.ToString());
                cur.Clear();
                any = false;
                continue;
            }
            cur.Append(ch);
            any = true;
        }
        if (any) parts.Add(cur.ToString());
        return (parts[0], parts.Skip(1).ToArray());
    }

    /// <summary>Starts the engine and waits for the line that says where it is.</summary>
    public static async Task<CoreProcess> StartAsync(string? lang, CancellationToken cancel)
    {
        var command = Command() ?? throw new CoreMissingException();
        var info = new ProcessStartInfo(command.File)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = AppContext.BaseDirectory,
        };
        foreach (var a in command.Args) info.ArgumentList.Add(a);
        info.ArgumentList.Add("desktop");
        if (!string.IsNullOrEmpty(lang))
        {
            info.ArgumentList.Add("--lang");
            info.ArgumentList.Add(lang);
        }
        var process = Process.Start(info) ?? throw new InvalidOperationException("The engine did not start.");
        var kept = new LinkedList<string>();
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            lock (kept)
            {
                kept.AddLast(e.Data);
                while (kept.Count > SaidKept) kept.RemoveFirst();
            }
        };
        process.BeginErrorReadLine();
        var exited = process.WaitForExitAsync(CancellationToken.None);

        // Reading ahead what changes on its own takes a few seconds on a large PC; a minute is long past it.
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        timeout.CancelAfter(TimeSpan.FromMinutes(1));
        string? line;
        try
        {
            var reading = process.StandardOutput.ReadLineAsync(timeout.Token).AsTask();
            var first = await Task.WhenAny(reading, exited);
            line = first == reading ? await reading : null;
        }
        catch (OperationCanceledException)
        {
            Kill(process);
            throw;
        }
        if (line is null)
        {
            Kill(process);
            string last;
            lock (kept) last = string.Join(Environment.NewLine, kept);
            throw new CoreStoppedException(last);
        }
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        var core = new CoreProcess(process, root.GetProperty("port").GetInt32(), root.GetProperty("key").GetString()!,
            root.TryGetProperty("solarljos", out var v) ? v.ToString() : "", exited);
        lock (kept) foreach (var s in kept) core.said.AddLast(s);
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            lock (core.said)
            {
                core.said.AddLast(e.Data);
                while (core.said.Count > SaidKept) core.said.RemoveFirst();
            }
        };
        return core;
    }

    static void Kill(Process p)
    {
        try
        {
            if (!p.HasExited) p.Kill(entireProcessTree: true);
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or AggregateException or NotSupportedException)
        {
            // Gone already, or not ours to end: the program is going either way.
        }
    }

    /// <summary>
    /// Stops the engine as its stdin closing tells it to: at once, or when the files being written
    /// are done. Past `wait` it is ended.
    /// </summary>
    public async Task StopAsync(TimeSpan wait)
    {
        try
        {
            process.StandardInput.Close();
        }
        catch (IOException)
        {
        }
        var done = await Task.WhenAny(Exited, Task.Delay(wait)).ConfigureAwait(false);
        if (done != Exited) Kill(process);
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false);
        process.Dispose();
    }
}

/// <summary>solarljos-core.exe is not beside this program.</summary>
public sealed class CoreMissingException : Exception
{
    public CoreMissingException() : base($"{CoreProcess.FileName} was not found beside Solarljos.exe.") { }
}

/// <summary>The engine stopped before it said where it was; `Said` is what it said.</summary>
public sealed class CoreStoppedException(string said) : Exception("The engine stopped before it started.")
{
    public string Said { get; } = said;
}
