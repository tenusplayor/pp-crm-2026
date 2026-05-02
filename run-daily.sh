#!/bin/bash
# Daily wrapper — logs output to exports/run.log
cd "$(dirname "$0")"
echo "--- $(date) ---" >> exports/run.log
/usr/local/bin/node download-payments.js >> exports/run.log 2>&1
echo "" >> exports/run.log
