using System.Globalization;
using System.Net.Http;
using System.Windows;
using Solarljos.Core;
using Solarljos.Dev;
using Solarljos.Text;
using Solarljos.Ui;

namespace Solarljos;

/// <summary>
/// The program: its window at once, in the language Windows is set to and dark, then the engine
/// (solarljos-core.exe beside it), which reads ahead what changes on its own before it answers;
/// when the window closes the engine is told to stop, and stops once what it is writing is done.
/// </summary>
public partial class App : Application
{
    public static Session? Session { get; private set; }
    static CoreProcess? core;

    /// <summary>The window was closed while files were being written: the engine is left to finish them.</summary>
    public static bool WaitForWrites { get; set; }

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        // Something unforeseen in a click or an answer must not take the window and its results
        // with it: it is said, as the page says an error, and the window stays. Nothing is logged
        // to disk.
        DispatcherUnhandledException += (_, ex) =>
        {
            ex.Handled = true;
            ShowUnexpected(ex.Exception);
        };
        TaskScheduler.UnobservedTaskException += (_, ex) => ex.SetObserved();
        var shot = Shot.FromEnvironment();
        var tr = Tr.Instance;
        tr.Use(tr.Pick(shot?.Lang is { } lang ? [lang] : [CultureInfo.CurrentUICulture.Name]));
        Theme.UseFontFor(tr.Code);
        if (shot is not null && !shot.Dark) Theme.Use(false);

        var window = new MainWindow();
        MainWindow = window;
        shot?.Place(window);
        window.Show();
        if (shot?.Rail is { } rail) window.ForceRail(rail);

        try
        {
            core = await CoreProcess.StartAsync(tr.Code, CancellationToken.None);
            var session = new Session(new CoreClient(core.Port, core.Key));
            await session.LoadAsync();
            await session.UseLanguageAsync(tr.Code);
            Session = session;
            session.Listen();
            window.Connected(session);
            _ = core.Exited.ContinueWith((_) => Dispatcher.BeginInvoke(() => window.CoreStopped(core.LastSaid())), TaskScheduler.Default);
        }
        catch (CoreMissingException)
        {
            window.CoreMissing();
        }
        catch (CoreStoppedException stopped)
        {
            window.CoreStopped(stopped.Said);
        }
        catch (Exception failed)
        {
            // Anything else that keeps the engine from starting -- blocked by antivirus or app
            // control, no answer within the minute, a first line not understood -- is said the
            // same way, rather than leaving "Starting" on for ever.
            window.CoreStopped(failed.Message);
        }

        if (shot is not null)
        {
            window.Go(shot.Route);
            await window.ActAsync(shot.Act);
            await shot.TakeAsync(window);
            Shutdown();
        }
    }

    static bool showing;

    static void ShowUnexpected(Exception e)
    {
        var tr = Tr.Instance;
        var message = Formats.ErrorText(e) + (e is CoreException or HttpRequestException ? "" : " (" + e.GetType().Name + ": " + e.Message + ")");
        Announce.Alert(message);
        if (showing || Current?.MainWindow is not { IsLoaded: true } w) return;
        showing = true;
        try
        {
            _ = Dialog.InformAsync(w, tr["error.title"], message, tr["common.close"]);
        }
        finally
        {
            showing = false;
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        Session?.Close();
        // The engine stops when its stdin closes; what it is writing finishes first. A folder being
        // written may take long, and the person chose to let it: it is not cut short then.
        core?.StopAsync(WaitForWrites ? TimeSpan.FromHours(4) : TimeSpan.FromSeconds(30)).GetAwaiter().GetResult();
        base.OnExit(e);
    }
}
