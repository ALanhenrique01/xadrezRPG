@echo off
title Xadrez D20 - Servidor
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo Instalando dependencias...
    call npm install
    if errorlevel 1 (
        echo [ERRO] Falha ao instalar dependencias.
        pause
        exit /b 1
    )
)

echo.
echo  ============================================
echo   Xadrez D20 rodando em http://localhost:3000
echo   Para jogar em rede local, use seu IP:3000
echo   Feche esta janela para parar o servidor.
echo  ============================================
echo.
node server.js
pause
