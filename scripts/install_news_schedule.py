"""(Re)register the GreaterNews morning/evening runs in Windows Task Scheduler — built to survive
shutdowns, restarts, sleep and power cuts:

  * daily trigger (06:03 / 17:00), plus a catch-up trigger at logon (and at boot when the task can
    run without anyone logged in);
  * "run as soon as possible after a missed start" (StartWhenAvailable) — PC off at 06:03, on at 07:40
    -> the morning run starts at ~07:40;
  * wakes the PC from sleep (needs "Allow wake timers" = Enable, set on AC power 2026-11-26);
  * runs on battery, retries a failed run 3x every 15 min, max 4h, never two copies at once.
news_run.py itself guarantees once-per-slot-per-day, resumes half-finished runs, and skips a slot when
it's too late (morning after 15:00, evening after 23:00) or too early (evening before 16:30).

  python scripts/install_news_schedule.py
"""

import os
import subprocess
import sys
import tempfile
from datetime import date

USER = f"{os.environ.get('COMPUTERNAME', '')}\\{os.environ.get('USERNAME', 'Administrator')}".lstrip("\\")
TASKS = [
    ("GreaterNews Morning Run", "06:03:00", r"C:\GreaterNews\morning-run.cmd",
     "GreaterNews morning news run: hot news -> cards/videos -> Facebook (2h review window) -> report."),
    ("GreaterNews Evening Run", "17:00:00", r"C:\GreaterNews\evening-run.cmd",
     "GreaterNews evening news run: stories since the morning -> Facebook (2h review window) -> report."),
]


def xml(name, at, command, description, s4u):
    start = date.today().isoformat()  # today: a time already passed is caught up harmlessly (news_run guards)
    boot = "<BootTrigger><Enabled>true</Enabled><Delay>PT5M</Delay></BootTrigger>" if s4u else ""
    logon_type = "S4U" if s4u else "InteractiveToken"
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>{description}</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger><StartBoundary>{start}T{at}</StartBoundary><Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
    <LogonTrigger><Enabled>true</Enabled><UserId>{USER}</UserId><Delay>PT3M</Delay></LogonTrigger>
    {boot}
  </Triggers>
  <Principals><Principal id="Author"><UserId>{USER}</UserId><LogonType>{logon_type}</LogonType>
    <RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>
    <Priority>6</Priority>
    <RestartOnFailure><Interval>PT15M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>{command}</Command><WorkingDirectory>C:\\GreaterNews</WorkingDirectory></Exec></Actions>
</Task>
"""


def register(name, body):
    path = os.path.join(tempfile.gettempdir(), "gn-task.xml")
    with open(path, "w", encoding="utf-16") as h:
        h.write(body)
    p = subprocess.run(["schtasks", "/create", "/tn", name, "/xml", path, "/f"], capture_output=True, text=True)
    os.remove(path)
    return p.returncode == 0, (p.stdout + p.stderr).strip()


def main():
    for name, at, command, description in TASKS:
        ok, out = register(name, xml(name, at, command, description, s4u=True))
        mode = "runs even when nobody is logged in (+ at boot)"
        if not ok:  # S4U needs admin rights; fall back to "only while logged in" + catch-up at logon
            ok, out = register(name, xml(name, at, command, description, s4u=False))
            mode = "runs while you're logged in (+ catch-up at logon)"
        print(f"{'OK ' if ok else 'FAILED'} {name}: {mode if ok else out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
