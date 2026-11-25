@echo off
setlocal EnableDelayedExpansion
rem Load the docgen writer model and wait until it answers.
rem Port 8080 belongs to the reranker: this script never binds or stops it.
rem Overrides: LLAMA_SERVER, DOCGEN_GGUF, QI_DOCGEN_PORT.

if not defined LLAMA_SERVER set "LLAMA_SERVER=C:\dev\llama.cpp\llama-server.exe"
if not defined DOCGEN_GGUF set "DOCGEN_GGUF=C:\dev\llama.cpp\models\Huihui-Qwen3.6-35B-A3B-abliterated.i1-Q4_K_M.gguf"
if not defined QI_DOCGEN_PORT set "QI_DOCGEN_PORT=8081"
set "ALIAS=doc-writer"
set "PORT=%QI_DOCGEN_PORT%"

if not exist "%LLAMA_SERVER%" (
	echo ERROR: llama-server.exe not found: "%LLAMA_SERVER%"
	echo Set LLAMA_SERVER to its full path and retry.
	exit /b 1
)
if not exist "%DOCGEN_GGUF%" (
	echo ERROR: model file not found: "%DOCGEN_GGUF%"
	echo Set DOCGEN_GGUF to its full path and retry.
	exit /b 1
)

echo Checking http://127.0.0.1:%PORT%/v1 ...
curl.exe -s -m 3 http://127.0.0.1:%PORT%/v1/models | findstr /c:"%ALIAS%" >nul 2>&1
if not errorlevel 1 (
	echo "%ALIAS%" is already serving on port %PORT%. Nothing to do.
	exit /b 0
)

echo Starting "%ALIAS%" on port %PORT% ...
start "docgen-model-%PORT%" /MIN "%LLAMA_SERVER%" -m "%DOCGEN_GGUF%" -c 16384 -np 1 -t 24 -ngl 99 --n-cpu-moe 99 --load-mode none -fa on -ctk q8_0 -ctv q8_0 --jinja --port %PORT% --alias %ALIAS%

echo Waiting for the model to load (experts stream from system RAM, up to 5 minutes)
set /a tries=0
:wait
set /a tries+=1
curl.exe -s -m 3 http://127.0.0.1:%PORT%/v1/models | findstr /c:"%ALIAS%" >nul 2>&1
if not errorlevel 1 goto ready
if !tries! geq 150 goto timeout
timeout /t 2 /nobreak >nul
<nul set /p =.
goto wait

:ready
echo.
set "PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do set "PID=%%P"
if defined PID (
	echo Ready: %ALIAS% on http://127.0.0.1:%PORT%/v1 ^(PID !PID!^)
) else (
	echo Ready: %ALIAS% on http://127.0.0.1:%PORT%/v1
)
echo Model window title: docgen-model-%PORT%
exit /b 0

:timeout
echo.
echo ERROR: no answer from %ALIAS% after 5 minutes.
echo Check the "docgen-model-%PORT%" window for a load error, then retry.
exit /b 1
