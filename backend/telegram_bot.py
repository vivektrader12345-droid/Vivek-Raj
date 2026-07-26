"""
Telegram Bot for Trade Alerts
==============================
Sends trade signals & execution alerts to your Telegram.

Setup:
1. Open Telegram, search @BotFather
2. Send /newbot → follow steps → get BOT_TOKEN
3. Get your Chat ID: search @userinfobot → send /start
4. Add token & chat_id to .env file
5. Run: python telegram_bot.py (or import in app.py)
"""

import requests
import os
from dotenv import load_dotenv

dotenv_path = os.path.join(os.path.dirname(__file__), ".env") 
load_dotenv(dotenv_path)

print(os.getenv("TELEGRAM_BOT_TOKEN"))
print(os.getenv("TELEGRAM_CHAT_ID"))

BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID', '')

def send_telegram(message):
    """Send message to Telegram"""
    if not BOT_TOKEN or not CHAT_ID:
        print("[TELEGRAM] Not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env")
        return False
    
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {
        'chat_id': CHAT_ID,
        'text': message,
        'parse_mode': 'HTML'
    }
    try:
        res = requests.post(url, json=payload)
        return res.status_code == 200
    except Exception as e:
        print(f"[TELEGRAM ERROR] {e}")
        return False


def send_signal_alert(action, symbol, price, sl='', tp='', strategy=''):
    """Send formatted trade signal"""
    emoji = '🟢' if 'BUY' in action.upper() else '🔴'
    msg = f"""
{emoji} <b>TRADE SIGNAL</b>

📊 <b>{symbol}</b>
📌 Action: <b>{action}</b>
💰 Price: <b>${price}</b>
🛑 Stop Loss: {sl if sl else 'N/A'}
🎯 Take Profit: {tp if tp else 'N/A'}
📈 Strategy: {strategy if strategy else 'Manual'}

⏰ Time: {os.popen('date /t').read().strip()} {os.popen('time /t').read().strip()}
    """
    return send_telegram(msg.strip())


def send_trade_executed(side, symbol, price, qty, pnl=None):
    """Send trade execution notification"""
    emoji = '✅' if pnl and pnl > 0 else '❌' if pnl and pnl < 0 else '📊'
    msg = f"""
{emoji} <b>TRADE EXECUTED</b>

📊 {symbol}
📌 Side: <b>{side.upper()}</b>
💰 Price: ${price}
📦 Quantity: {qty}
{f'💵 P&L: <b>${pnl:.2f}</b>' if pnl else ''}

🤖 Vivek Marco Trader
    """
    return send_telegram(msg.strip())


def send_daily_summary(total_trades, wins, losses, pnl, balance):
    """Send daily trading summary"""
    msg = f"""
📋 <b>DAILY SUMMARY</b>

📊 Total Trades: {total_trades}
✅ Wins: {wins}
❌ Losses: {losses}
💰 Day P&L: <b>${pnl:.2f}</b>
🏦 Balance: ${balance:.2f}
📈 Win Rate: {((wins/total_trades)*100):.1f}% 

🐂 Vivek Marco Trader
    """
    return send_telegram(msg.strip())


if __name__ == '__main__':
    # Test
    print("Testing Telegram Bot...")
    if send_telegram("🐂 Vivek Marco Trader Bot is active! ✅"):
        print("✅ Message sent successfully!")
    else:
        print("❌ Failed. Check BOT_TOKEN and CHAT_ID in .env")
