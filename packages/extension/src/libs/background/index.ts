import {
  ActionSendMessage,
  InternalMethods,
  InternalOnMessageResponse,
  Message,
} from "@/types/messenger";
import { KeyRecord, KeyRecordAdd, RPCRequestType } from "@enkryptcom/types";
import { getCustomError } from "../error";
import KeyRingBase from "../keyring/keyring";
import { sendToWindow } from "@/libs/messenger/extension";
import {
  EnkryptProviderEventMethods,
  NodeType,
  ProviderName,
} from "@/types/provider";
import { OnMessageResponse } from "@enkryptcom/types";
import EthereumProvider from "@/providers/ethereum";
import PolkadotProvider from "@/providers/polkadot";
import Browser from "webextension-polyfill";
import TabInfo from "@/libs/utils/tab-info";
import PersistentEvents from "@/libs/persistent-events";
import TabStates from "@/libs/tab-state";
import { TabProviderType, ProviderType, ExternalMessageOptions } from "./types";
import { getNetworkByName } from "../utils/networks";

class BackgroundHandler {
  #keyring: KeyRingBase;
  #tabProviders: TabProviderType;
  #providers: ProviderType;
  #persistentEvents: PersistentEvents;
  #tabStates: TabStates;
  constructor() {
    this.#keyring = new KeyRingBase();
    this.#persistentEvents = new PersistentEvents();
    this.#tabStates = new TabStates();
    this.#tabProviders = {
      [ProviderName.ethereum]: {},
      [ProviderName.polkadot]: {},
    };
    this.#providers = {
      [ProviderName.ethereum]: EthereumProvider,
      [ProviderName.polkadot]: PolkadotProvider,
    };
  }
  async init(): Promise<void> {
    const allPersistentEvents = await this.#persistentEvents.getAllEvents();
    const tabs = Object.keys(allPersistentEvents).map((s) => parseInt(s));
    const persistentEventPromises: Promise<void>[] = [];
    tabs.forEach((tab) => {
      const tabPromise = Browser.tabs
        .get(tab)
        .then(() => {
          const eventPromises: Promise<OnMessageResponse | undefined>[] = [];
          allPersistentEvents[tab].forEach((persistentEvent) => {
            const promise = this.externalHandler(persistentEvent.event, {
              savePersistentEvents: false,
            }).then((newResponse) => {
              if (
                !newResponse.error &&
                newResponse.result !== persistentEvent.response.result
              ) {
                return sendToWindow(
                  {
                    provider: persistentEvent.event.provider,
                    message: JSON.stringify({
                      method: EnkryptProviderEventMethods.persistentEvents,
                      params: [
                        JSON.parse(persistentEvent.event.message),
                        persistentEvent.response.result,
                        newResponse.result,
                      ],
                    }),
                  },
                  tab
                );
              }
            });
            eventPromises.push(promise);
          });
          return Promise.all(eventPromises);
        })
        .catch(() => {
          this.#persistentEvents.deleteEvents(tab);
        });
      persistentEventPromises.push(tabPromise as any);
    });
    await Promise.all(persistentEventPromises);
  }
  async externalHandler(
    msg: Message,
    options: ExternalMessageOptions = { savePersistentEvents: true }
  ): Promise<OnMessageResponse> {
    const { method, params } = JSON.parse(msg.message);
    const _provider = msg.provider;
    const _tabid = msg.sender.tabId;
    if (_provider === ProviderName.enkrypt) {
      if (
        method === InternalMethods.newWindowInit ||
        method === InternalMethods.newWindowUnload
      ) {
        this.#persistentEvents.deleteEvents(_tabid);
        this.#tabStates.deleteStateById(_tabid);
        return {
          result: JSON.stringify(true),
        };
      }
      return {
        error: JSON.stringify(getCustomError("Enkrypt: not implemented")),
      };
    }
    if (!this.#tabProviders[_provider][_tabid]) {
      const toWindow = (message: string) => {
        sendToWindow(
          {
            provider: _provider,
            message,
          },
          _tabid
        );
      };
      this.#tabProviders[_provider][_tabid] = new this.#providers[_provider](
        toWindow
      );
    }
    const isPersistent = await this.#tabProviders[_provider][
      _tabid
    ].isPersistentEvent({ method, params });
    return this.#tabProviders[_provider][_tabid]
      .request({
        method,
        params,
        options: TabInfo(await Browser.tabs.get(_tabid)),
      })
      .then((response) => {
        if (isPersistent && !response.error && options.savePersistentEvents)
          return this.#persistentEvents
            .addEvent(_tabid, msg, response)
            .then(() => response);
        return response;
      });
  }
  internalHandler(msg: Message): Promise<InternalOnMessageResponse> {
    const message = JSON.parse(msg.message) as RPCRequestType;
    if (message.method === InternalMethods.sign) {
      if (!message.params || message.params.length < 2)
        return Promise.resolve({
          error: getCustomError("background: invalid params for signing"),
        });
      const msgHash = message.params[0] as `0x${string}`;
      const account = message.params[1] as KeyRecord;
      return this.#keyring
        .sign(msgHash, account)
        .then((sig) => {
          return {
            result: JSON.stringify(sig),
          };
        })
        .catch((e) => {
          return {
            error: getCustomError(e.message),
          };
        });
    } else if (message.method === InternalMethods.unlock) {
      if (!message.params || message.params.length < 1)
        return Promise.resolve({
          error: getCustomError("background: invalid params for unlocking"),
        });
      const password = message.params[0] as string;
      return this.#keyring
        .unlock(password)
        .then(() => {
          return {
            result: JSON.stringify(true),
          };
        })
        .catch((e) => {
          return {
            error: getCustomError(e.message),
          };
        });
    } else if (message.method === InternalMethods.changeNetwork) {
      if (!message.params || message.params.length < 1)
        return Promise.resolve({
          error: getCustomError(
            "background: invalid params for change network"
          ),
        });
      const networkName = message.params[0] as string;
      const network = getNetworkByName(networkName) as NodeType;
      const actionMsg = msg as any as ActionSendMessage;
      if (
        actionMsg.provider &&
        actionMsg.tabId &&
        this.#tabProviders[actionMsg.provider][actionMsg.tabId]
      ) {
        this.#tabProviders[actionMsg.provider][
          actionMsg.tabId
        ].setRequestProvider(network);
      }
      return Promise.resolve({
        result: JSON.stringify(true),
      });
    } else if (message.method === InternalMethods.isLocked) {
      return Promise.resolve({
        result: JSON.stringify(this.#keyring.isLocked()),
      });
    } else if (message.method === InternalMethods.sendToTab) {
      const actionMsg = msg as any as ActionSendMessage;
      if (
        actionMsg.provider &&
        actionMsg.tabId &&
        this.#tabProviders[actionMsg.provider][actionMsg.tabId]
      ) {
        this.#tabProviders[actionMsg.provider][
          actionMsg.tabId
        ].sendNotification(
          JSON.stringify(message.params?.length ? message.params[0] : {})
        );
        return Promise.resolve({
          result: JSON.stringify(true),
        });
      } else {
        return Promise.resolve({
          result: JSON.stringify(false),
        });
      }
    } else if (
      message.method === InternalMethods.getNewAccount ||
      message.method === InternalMethods.saveNewAccount
    ) {
      if (!message.params || message.params.length < 1)
        return Promise.resolve({
          error: getCustomError("background: invalid params for new account"),
        });
      const method =
        message.method === InternalMethods.getNewAccount
          ? "getNewAccount"
          : "saveNewAccount";
      const keyrecord = message.params[0] as KeyRecordAdd;
      return this.#keyring
        [method](keyrecord)
        .then((res) => {
          return {
            result: JSON.stringify(res),
          };
        })
        .catch((e) => {
          return {
            error: getCustomError(e.message),
          };
        });
    } else {
      return Promise.resolve({
        error: getCustomError(`background: unknown method: ${message.method}`),
      });
    }
  }
}

export default BackgroundHandler;
