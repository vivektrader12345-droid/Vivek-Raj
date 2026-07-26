"""
Multi-Exchange Support
=======================
Supports: Binance, Bybit, OKX, Coinbase Pro

Usage:
  from multi_exchange import get_exchange, execute_order
  
  exchange = get_exchange('binance', api_key, api_secret)
  order = execute_order(exchange, 'BTC/USDT', 'buy', amount=10)
"""

import ccxt

SUPPORTED_EXCHANGES = {
    'binance': {
        'class': ccxt.binance,
        'name': 'Binance',
        'testnet': True,
    },
    'bybit': {
        'class': ccxt.bybit,
        'name': 'Bybit',
        'testnet': True,
    },
    'okx': {
        'class': ccxt.okx,
        'name': 'OKX',
        'testnet': True,
    },
    'coinbase': {
        'class': ccxt.coinbase,
        'name': 'Coinbase',
        'testnet': False,
    },
}


def get_exchange(exchange_id, api_key, api_secret, testnet=True, passphrase=''):
    """
    Connect to an exchange.
    
    Args:
        exchange_id: 'binance', 'bybit', 'okx', 'coinbase'
        api_key: API key
        api_secret: API secret
        testnet: Use testnet/sandbox mode
        passphrase: Required for OKX
    
    Returns:
        ccxt exchange instance or None
    """
    if exchange_id not in SUPPORTED_EXCHANGES:
        raise ValueError(f"Unsupported exchange: {exchange_id}. Supported: {list(SUPPORTED_EXCHANGES.keys())}")
    
    config = SUPPORTED_EXCHANGES[exchange_id]
    
    params = {
        'apiKey': api_key,
        'secret': api_secret,
        'enableRateLimit': True,
    }
    
    if exchange_id == 'okx' and passphrase:
        params['password'] = passphrase
    
    if testnet and config['testnet']:
        params['sandbox'] = True
    
    try:
        exchange = config['class'](params)
        # Test connection
        balance = exchange.fetch_balance()
        print(f"[OK] {config['name']} connected!")
        return exchange
    except Exception as e:
        print(f"[ERROR] {config['name']} connection failed: {e}")
        return None


def execute_order(exchange, symbol, side, amount_usdt=10, order_type='market', price=None):
    """
    Execute trade on any exchange.
    
    Args:
        exchange: ccxt exchange instance
        symbol: 'BTC/USDT'
        side: 'buy' or 'sell'
        amount_usdt: Amount in USDT
        order_type: 'market' or 'limit'
        price: Required for limit orders
    
    Returns:
        dict with order details
    """
    try:
        ticker = exchange.fetch_ticker(symbol)
        current_price = ticker['last']
        quantity = amount_usdt / current_price
        
        if order_type == 'market':
            order = exchange.create_market_order(symbol, side, quantity)
        elif order_type == 'limit':
            if not price:
                price = current_price
            order = exchange.create_limit_order(symbol, side, quantity, price)
        
        return {
            'status': 'success',
            'order_id': order.get('id'),
            'symbol': symbol,
            'side': side,
            'price': current_price,
            'quantity': quantity,
            'amount_usdt': amount_usdt,
            'type': order_type,
        }
    except Exception as e:
        return {
            'status': 'error',
            'message': str(e),
            'symbol': symbol,
            'side': side,
        }


def get_balance(exchange, currency='USDT'):
    """Get balance for a currency"""
    try:
        balance = exchange.fetch_balance()
        return {
            'free': balance.get(currency, {}).get('free', 0),
            'used': balance.get(currency, {}).get('used', 0),
            'total': balance.get(currency, {}).get('total', 0),
        }
    except Exception as e:
        return {'error': str(e)}


def get_ticker(exchange, symbol):
    """Get current price"""
    try:
        ticker = exchange.fetch_ticker(symbol)
        return {
            'symbol': symbol,
            'price': ticker['last'],
            'high': ticker['high'],
            'low': ticker['low'],
            'volume': ticker['baseVolume'],
            'change': ticker.get('percentage', 0),
        }
    except Exception as e:
        return {'error': str(e)}
