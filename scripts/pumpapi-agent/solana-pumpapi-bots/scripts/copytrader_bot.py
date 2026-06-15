'''
EXAMPLE STRATEGY: COPYTRADER BOT. WE COPY ONLY WALLETS FROM COPIED_WALLETS. WHEN A COPIED WALLET BUYS, WE BUY 1/10 OF HIS QUOTE AMOUNT, BUT NOT MORE THAN MAX_SOL_AMOUNT_TO_BUY SOL. THIS CAP IS NEEDED SO THE COPIED WALLET DOESN'T WANT TO EXIT AFTER OUR BUY. WHEN HE SELLS, WE SELL THE SAME CUMULATIVE PERCENTAGE, ROUNDED UP. WE TRADE ONLY PUMP.FUN / PUMP-AMM POOLS CREATED BY PUMP, NOT MAYHEMMODE.
'''

import asyncio
import aiohttp
import websockets
import orjson as json
import logging
from cachetools import TTLCache
import traceback
from collections import defaultdict
import time
import math
from notify_user import notify

CHAT_ID = # CHAT ID YOU GOT USING NOTIFY USER SKILL
PLATFORM = # PLATFORM YOU GOT USING NOTIFY USER SKILL
MY_SOLANA_B58_PRIVATE_KEY = # YOUR PRIVATE KEY FROM /etc/environment , put it here, don't use os.environ.get
MY_SOLANA_B58_PUBLIC_KEY = # YOUR PUBLIC KEY FROM /etc/environment

COPIED_WALLETS = {
    'WALLET_TO_COPY_1',
    'WALLET_TO_COPY_2',
}

processed_signatures = TTLCache(maxsize=10000, ttl=300)

WSOL = 'So11111111111111111111111111111111111111112'
USDC  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' # if the user doesn’t have USDC in their balance, avoid such quote tokens. Use the logic from the sell all tokens script to check token balances.
global_dict = {'sol_price': 80}
MAX_SOL_AMOUNT_TO_BUY = 0.01 # we buy 1/10 of copied trade, but cap it so the copied wallet doesn't want to exit after our buy
strategy_dict = {WSOL: {'max_amount_to_buy': MAX_SOL_AMOUNT_TO_BUY, 'ui_name': 'sol','post_balances_field_name': 'sol'},
                 USDC: {'max_amount_to_buy': MAX_SOL_AMOUNT_TO_BUY*global_dict['sol_price'], 'ui_name': 'USDC', 'post_balances_field_name': USDC}}
bought_mints = defaultdict(dict)
our_balances = {}

logging.basicConfig(
    handlers=[
        logging.FileHandler("logs_for_agent.log", mode="w", encoding="utf-8"),
        logging.StreamHandler()
    ],
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)

async def make_pumpapi_trade(aiohttp_session, action, mint_address, quote_mint_address, amount, slippage, price):
    logging.info(f"copied wallet trade -> {action} {amount} {quote_mint_address}!")
    try:
        if mint_address not in bought_mints:
            bought_mints[mint_address] = {'quote_mint_address': quote_mint_address,'buy_confirmed': False, 'sell_confirmed': False, "quote_amount_spent": amount if action == 'buy' else 0, "entry_price": price, "entry_time": time.time(), 'our_sold_percentage': 0}
        else:
            if action == 'buy':
                logging.info(f'Mint {mint_address} already bought - skip')
                return
        async with aiohttp_session.post(
            url=f"https://api.pumpapi.io",
            data={
                "privateKey": MY_SOLANA_B58_PRIVATE_KEY,
                "action": action,
                "mint": mint_address,
                "quoteMint": quote_mint_address,
                "amount": amount,
                "denominatedInQuote": "true",
                "slippage": slippage,
            }
        ) as response:
            response = await response.json()
            if 'signature' not in response:
                logging.info(f'No signature in response: {response}')
                return
            our_purchase_event = None
            for i in range (30): # wait  3 sec to get tx from the data stream - no tx - skip.
                await asyncio.sleep(0.1)
                events_from_our_tx = processed_signatures.get(response['signature'], [])
                for event in events_from_our_tx:
                    if event['action'] == action and event['mint'] == mint_address:
                        our_purchase_event = event
                    if our_purchase_event:
                        # WE FOUND OUR OWN TRANSACTION IN DATA STREAM

                        quote_balance = our_purchase_event['postBalances'][MY_SOLANA_B58_PUBLIC_KEY][strategy_dict[quote_mint_address]['post_balances_field_name']] # WSOL account is temporary. When trading through PumpApi, the WSOL account is always closed after the trade, so we should look at the native SOL balance. (sol)
                        ui_quote_name = strategy_dict[quote_mint_address]['ui_name']
                        our_balances[quote_mint_address] = quote_balance
                        if action == 'buy':
                            bought_mints[mint_address]['buy_confirmed'] = True
                            bought_mints[mint_address]['quote_amount_spent'] = our_purchase_event['quoteAmount']
                            bought_mints[mint_address]['entry_price'] = our_purchase_event['price']
                            logging.info(f'BUY SUCCESS! {our_purchase_event}\n {ui_quote_name} balance - {quote_balance}')
                            notify(platform = PLATFORM, chat_id = CHAT_ID, text=f"🟩 Copytrade BUY\n\n🪙 Mint: {mint_address}\n📦 Tokens received: {our_purchase_event['tokenAmount']}\n💰 Spent: {our_purchase_event['quoteAmount']} {ui_quote_name}\n📊 Entry price: {our_purchase_event['price']}\n🏦 {ui_quote_name} balance: {quote_balance}")
                        elif action == 'sell':
                            bought_mints[mint_address]['sell_confirmed'] = True
                            bought_mints[mint_address]['quote_amount_got'] = bought_mints[mint_address].get('quote_amount_got', 0) + our_purchase_event['quoteAmount']
                            bought_mints[mint_address]['exit_price'] = our_purchase_event['price']
                            quote_amount_got = bought_mints[mint_address]['quote_amount_got']
                            quote_amount_spent = bought_mints[mint_address]['quote_amount_spent']
                            profit = quote_amount_got - quote_amount_spent
                            logging.info(f'{our_purchase_event}\nSELL SUCCESS!\nPROFIT {profit} quote mint - {ui_quote_name}\n balance - {quote_balance}')
                            notify(platform = PLATFORM, chat_id = CHAT_ID, text=f"🚩 Copytrade SELL\n\n🪙 Mint: {mint_address}\n📤 Amount sold: {amount}\n💱 Quote mint: {ui_quote_name}\n💰 Profit: {profit:+.8f} {ui_quote_name}\n🏦 {ui_quote_name} balance: {quote_balance}")
                            if amount == '100%':
                                bought_mints.pop(mint_address,None)

                        break
                if our_purchase_event:
                    break
    except:
        logging.info(f'ERROR! traceback in make_pumpapi_trade --> {traceback.format_exc()}')


def is_trusted_pool(event):
    return not event.get('mayhemMode') and (event['pool'] == 'pump' or (event['pool'] == 'pump-amm' and event.get('poolCreatedBy') == 'pump')) # avoiding scam pools/tokens. This is needed so the copied wallet can't lead us into his scam pool or force us to buy his scam token. We buy only in normal trusted pools.


def event_has_copied_wallet(event):
    post_balances = event.get('postBalances', {})
    traders_involved = event.get('tradersInvolved', {})
    return event.get('txSigner') in COPIED_WALLETS or any(wallet in post_balances or wallet in traders_involved for wallet in COPIED_WALLETS)


def post_balances_token_amount(event):
    mint_address = event['mint']
    return sum(wallet_balances.get(mint_address, 0) for wallet_balances in event.get('postBalances', {}).values())


def is_first_buy(event):
    token_amount = event['tokenAmount']
    post_token_amount = post_balances_token_amount(event) # if he bought from another wallet in the same tx, it will also be in postBalances. If postBalances token total differs from tokenAmount, he already had this token, so entering is risky - skip.
    return abs(post_token_amount - token_amount) <= max(0.000001, token_amount * 0.000001)


def get_sell_percentage(bought_mint_dict, event):
    bought_mint_dict['copied_sold_amount'] += event['tokenAmount']
    copied_sold_percentage = min(100, math.ceil(bought_mint_dict['copied_sold_amount'] / bought_mint_dict['copied_token_amount'] * 100))
    our_sold_percentage = bought_mint_dict['our_sold_percentage']
    if copied_sold_percentage <= our_sold_percentage:
        return None
    amount = '100%' if copied_sold_percentage >= 100 else f"{math.ceil((copied_sold_percentage - our_sold_percentage) * 100 / (100 - our_sold_percentage))}%"
    bought_mint_dict['our_sold_percentage'] = copied_sold_percentage
    return amount


async def pumpapi_data_stream(ws_url, aiohttp_session):
    async with websockets.connect(ws_url) as websocket:
        async for message in websocket:
            event = json.loads(message)
            signature = event['signature']
            if signature in processed_signatures:
                processed_signatures[signature].append(event)
            else:
                processed_signatures[signature] = [event]
            
            if event.get('poolId') == 'Gf7sXMoP8iRw4iiXmJ1nq4vxcRycbGXy5RL8a8LnTd3v': # not every event has poolId that's why we use .get() | this is major trusted SOL-USDC pool
                sol_price = 1/event['price']
                global_dict['sol_price'] = sol_price
                logging.info(f"Current sol price is {sol_price}")
                strategy_dict[USDC]['max_amount_to_buy'] = strategy_dict[WSOL]['max_amount_to_buy'] * sol_price # adjustment by price

            elif event['action'] in ['buy', 'sell'] and is_trusted_pool(event) and event_has_copied_wallet(event):
                mint_address = event['mint']
                quote_mint_address = event['quoteMint']
                if quote_mint_address not in strategy_dict:
                    logging.info(f"Quote mint is not WSOL/USDC - skip")
                    continue
                if event['action'] == 'buy' and mint_address not in bought_mints:
                    if not is_first_buy(event):
                        logging.info(f"Copied wallet already had {mint_address} - skip")
                        continue
                    bought_mints[mint_address] = {'quote_mint_address': quote_mint_address,'buy_confirmed': False, 'sell_confirmed': False, "quote_amount_spent": 0, "entry_price": event['price'], "entry_time": time.time(), 'our_sold_percentage': 0, 'copied_token_amount': event['tokenAmount'], 'copied_sold_amount': 0}
                    amount_to_buy = min(event['quoteAmount'] / 10, strategy_dict[quote_mint_address]['max_amount_to_buy'])
                    asyncio.create_task(make_pumpapi_trade(aiohttp_session=aiohttp_session, action='buy', mint_address=mint_address, quote_mint_address=quote_mint_address, amount=amount_to_buy, slippage=20, price = event['price']))
                elif event['action'] == 'sell' and mint_address in bought_mints:
                    bought_mint_dict = bought_mints[mint_address]
                    if not bought_mint_dict.get('buy_confirmed'):
                        logging.info(f'{mint_address}: buy not confirmed, nothing to sell')
                        continue
                    amount_to_sell = get_sell_percentage(bought_mint_dict, event)
                    if amount_to_sell:
                        asyncio.create_task(make_pumpapi_trade(aiohttp_session=aiohttp_session, action='sell', mint_address=mint_address, quote_mint_address=bought_mint_dict['quote_mint_address'], amount=amount_to_sell, slippage=99, price = None))

async def periodical_notifier():
    while True:
        try:
            await asyncio.sleep(30)
            if our_balances:
                logging.info(f"Current balances: {our_balances}")
                notify(platform = PLATFORM, chat_id = CHAT_ID, text=f"📡 Copytrader heartbeat\n\nBot is running and watching copied wallets.\n🏦 Current balances: {our_balances}")
            else:
                logging.info(f"No balance changes yet")
                notify(platform = PLATFORM, chat_id = CHAT_ID, text="📡 Copytrader heartbeat\n\nBot is running. No balance changes yet — still watching copied wallets.")
        except:
            logging.info(f'ERROR! traceback in make_pumpapi_trade --> {traceback.format_exc()}')

async def start_bot():
    ws_url = "wss://stream.pumpapi.io/"
    aiohttp_session = aiohttp.ClientSession()
    asyncio.create_task(periodical_notifier())
    while True:
        try:
            await pumpapi_data_stream(ws_url = ws_url, aiohttp_session = aiohttp_session)
        except:
            logging.info(f'ERROR! traceback in pumpapi_data_stream --> {traceback.format_exc()}')
            await asyncio.sleep(0.4)




asyncio.run(start_bot())
