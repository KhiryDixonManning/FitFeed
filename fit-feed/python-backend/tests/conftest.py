import os
import sys

# The backend is a flat module directory, not an installed package.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Never let a developer's real key be used by the test suite. Popped at import
# time, before anything can read it into a module-level client, so the suite
# cannot make a paid Anthropic call even on a machine where a key is exported.
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("GOOGLE_CREDENTIALS_JSON", None)
os.environ.pop("ADMIN_API_KEY", None)


_SKIPPED: list[tuple[str, str]] = []


def pytest_runtest_logreport(report):
    """Remember anything that skipped, so CI can refuse to call that a pass."""
    if report.skipped:
        reason = ""
        if isinstance(report.longrepr, tuple) and len(report.longrepr) == 3:
            reason = report.longrepr[2]
        _SKIPPED.append((report.nodeid, reason))


def pytest_sessionfinish(session, exitstatus):
    """Fail the run when a suite that is expected to execute silently skipped.

    A skipped test reads as green in a summary line but proves nothing. The
    emulator-backed suites in particular skip themselves when the emulator is
    absent, which is exactly the failure CI needs to catch rather than report
    as success. Off by default so a developer can still run a subset locally.
    """
    if os.environ.get("FITFEED_FORBID_SKIPS") != "1" or not _SKIPPED:
        return

    reporter = session.config.pluginmanager.get_plugin("terminalreporter")
    if reporter is not None:
        reporter.write_line("")
        reporter.write_line(
            f"FITFEED_FORBID_SKIPS=1: {len(_SKIPPED)} test(s) skipped; "
            "a skipped test is not a passing test.",
            red=True,
        )
        for node_id, reason in _SKIPPED:
            reporter.write_line(f"  skipped: {node_id}  {reason}".rstrip(), red=True)

    session.exitstatus = 1
