import type { AnimeIdentity, AnimeListEntry } from "../core/types.js";
import type { StreamingProviderId } from "./streaming-provider.js";
import { normalizeYummyLists, yummyTrackerApi } from "./streaming-tracker-api.js";

export interface StreamingTrackerCapabilities {
  accountConnection: boolean; listImport: boolean; listStatusWrite: boolean;
  progressWrite: boolean; scoreWrite: boolean; favoriteWrite: boolean; reason?: string;
}
export interface StreamingTrackerAccountAdapter {
  readonly id: StreamingProviderId; readonly capabilities: StreamingTrackerCapabilities;
  connect(login: string, password: string): Promise<void>; disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  importList(): Promise<Array<{ anime: AnimeIdentity; entry: AnimeListEntry }>>;
  setStatusList?(externalId: string, listId: number): Promise<void>;
  setFavorite?(externalId: string, favorite: boolean): Promise<void>;
}
const CAPABILITIES: Record<StreamingProviderId, StreamingTrackerCapabilities> = {
  yummyanime: {
    accountConnection:true,listImport:true,listStatusWrite:true,progressWrite:false,scoreWrite:false,favoriteWrite:true,
    reason:"Импорт списка, статус через выбранный список и избранное. Прогресс и оценка пока не обновляются этим адаптером.",
  },
  animego: {
    accountConnection:false,listImport:false,listStatusWrite:false,progressWrite:false,scoreWrite:false,favoriteWrite:false,
    reason:"Импорт доступен через расширение на открытой странице профиля, по одному статусу за раз. Пароль не запрашивается. Запись в AnimeGO пока не реализована.",
  },
  anixart: {
    accountConnection:false,listImport:false,listStatusWrite:false,progressWrite:false,scoreWrite:false,favoriteWrite:false,
    reason:"Аккаунт API не подключается. Импорт доступен через собственный CSV/TXT экспорт Anixart; пароль не запрашивается. Обратная запись не реализована.",
  },
};
export function getStreamingTrackerCapabilities(provider:StreamingProviderId):StreamingTrackerCapabilities{return{...CAPABILITIES[provider]};}
export const streamingTrackerRegistry:Record<StreamingProviderId,StreamingTrackerAccountAdapter>={
 yummyanime:{
  id:"yummyanime",capabilities:CAPABILITIES.yummyanime,
  async connect(login,password){await yummyTrackerApi.login(login,password);},
  async disconnect(){await yummyTrackerApi.logout();},
  async isConnected(){return(await yummyTrackerApi.status()).connected;},
  async importList(){return normalizeYummyLists(await yummyTrackerApi.lists());},
  async setStatusList(externalId,listId){await yummyTrackerApi.setList(externalId,listId);},
  async setFavorite(externalId,favorite){await yummyTrackerApi.setFavorite(externalId,favorite);},
 },
 animego:{
  id:"animego",capabilities:CAPABILITIES.animego,
  async connect(){throw new Error(CAPABILITIES.animego.reason);},
  async disconnect(){throw new Error("AnimeGO account integration is not enabled.");},
  async isConnected(){return false;},
  async importList(){throw new Error(CAPABILITIES.animego.reason);},
 },
 anixart:{
  id:"anixart",capabilities:CAPABILITIES.anixart,
  async connect(){throw new Error(CAPABILITIES.anixart.reason);},
  async disconnect(){throw new Error("Anixart account integration is not enabled.");},
  async isConnected(){return false;},
  async importList(){throw new Error(CAPABILITIES.anixart.reason);},
 },
};
