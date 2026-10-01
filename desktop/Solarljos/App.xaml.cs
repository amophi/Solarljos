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

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
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
        catch (Exception failed) when (failed is HttpRequestException or CoreException or System.Text.Json.JsonException)
        {
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

    protected override void OnExit(ExitEventArgs e)
    {
        Session?.Close();
        // The engine stops when its stdin closes; a restore it is writing finishes first.
        core?.StopAsync(TimeSpan.FromSeconds(30)).GetAwaiter().GetResult();
        base.OnExit(e);
    }
}
