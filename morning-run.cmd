@echo off
rem GreaterNews MORNING run (Task Scheduler, daily ~06:00): hot news -> pack/cards/queue (Claude API
rem credit first) -> render -> Facebook posts scheduled 2h out -> Deep Dive on Mon/Wed/Fri -> report
rem on Telegram/email/PC pop-up. All steps live in scripts\news_run.py (log: content\news-run.log).
cd /d C:\GreaterNews
C:\Users\Administrator\anaconda3\python.exe C:\GreaterNews\scripts\news_run.py --slot morning >> C:\GreaterNews\content\morning-run.log 2>&1
