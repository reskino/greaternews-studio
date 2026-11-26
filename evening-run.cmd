@echo off
rem GreaterNews EVENING run (Task Scheduler, daily ~17:00): stories that broke since the morning ->
rem cards/queue (label <date>-pm) -> render -> Facebook posts scheduled 2h out -> report. See scripts\news_run.py.
cd /d C:\GreaterNews
C:\Users\Administrator\anaconda3\python.exe C:\GreaterNews\scripts\news_run.py --slot evening >> C:\GreaterNews\content\morning-run.log 2>&1
