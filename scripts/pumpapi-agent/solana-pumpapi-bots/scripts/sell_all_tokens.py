import requests
import logging
import traceback
from notify_user import notify

CHAT_ID = # CHAT ID YOU GOT USING NOTIFY USER SKILL
PLATFORM = # PLATFORM YOU GOT USING NOTIFY USER SKILL
MY_SOLANA_B58_PRIVATE_KEY = # YOUR PRIVATE KEY FROM /etc/environment, put it here, don't use os.environ.get
MY_SOLANA_B58_PUBLIC_KEY = # YOUR PUBLIC KEY FROM /etc/environment

logging.basicConfig(
    handlers=[
        logging.FileHandler("logs_for_agent.log", mode="w", encoding="utf-8"),
        logging.StreamHandler()
    ],
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)

url = "http://api.pumpapi.io"
burn_after_unsuccesful_sell_allowed = False
def get_payload(action, mint_address):
    data = {
        "privateKey": MY_SOLANA_B58_PRIVATE_KEY,
        "action": action,
        "mint": mint_address, # no need to pass quoteMint , it will be detected authomaticaly , and you will get USDC/ SOL (WSOL always closed after action) or any other quote token.
        "amount": '100%',
        "denominatedInQuote": "true",
        "slippage": 100,
        "guaranteedDelivery": "true" # NEVER USE THIS IN LIVE BOTS, YOU WILL END WITH 10 SEC AWAITING IF TX FAILED DUE TO SLIPPAGE. USE DATA STREAM CONFIRMATION. THIS FIELD SUITABLE ONLY IN THIS SCENARIO.
    }
    return data


def sell_everything(mint_address):
    try:
        data = get_payload(action='sell', mint_address=mint_address)

        response = requests.post(url, json=data).json()
        if response['confirmed']: # The confirmed field is only present in guaranteedDelivery mode (it waits 10 sec until succesful tx seen in network).  Drawback: it does not distinguish failed txs from unlanded txs. If a tx fails due to slippage, confirmed will be false.
            logging.info(f"mint {mint_address} sold successfully | quoteMint -> {response["trades"][0]['quoteMint']}")
            notify(platform = PLATFORM, chat_id = CHAT_ID, text=f"✅ Token sold successfully\n\n🪙 Mint: {mint_address}\n💱 Quote mint received: {quote_mint}\n✨ Status: confirmed on-chain")
        else:
            if burn_after_unsuccesful_sell_allowed:
                logging.info('not sold -> burn everything')
                data = get_payload(action='burn', mint_address=mint_address)
                response = requests.post(url, json=data).json()
                if response['confirmed']:
                    logging.info('burned successfully')
                else:
                    logging.info('burn not confirmed or failed')
            else:
                logging.info('sell not confirmed or failed')
    except:
        logging.info(f'ERROR! traceback in sell_everything --> {traceback.format_exc()}')
data = {
    "privateKey": MY_SOLANA_B58_PRIVATE_KEY,  # fee taken from this wallet
    "action": "getBalances",
    # "publicKey": any_pubkey, # no need to pass it , by default it checks for publicKey derived from privateKey.
}

response = requests.post(url, json=data).json()
if not response['tokenBalances']:
    notify(platform = PLATFORM, chat_id = CHAT_ID, text=f"No tokens to sell")
    notify(platform = PLATFORM, chat_id = CHAT_ID, text="🧹 No token balances found — nothing to sell.")
else:
    for mint_address, mint_data in response['tokenBalances'].items():
        sell_everything(mint_address)
    notify(platform = PLATFORM, chat_id = CHAT_ID, text=f"🧹 Token sale ended")
