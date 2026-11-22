import { useEffect, useMemo, useState } from "react";
import type { AnimeIdentity, AnimeListEntry, AnimeStatus } from "../core/types.js";
import { normalizeYummyLists, yummyTrackerApi, type YummyAccountStatus } from "../services/streaming-tracker-api.js";
import { runConfirmedTrackerWrites } from "../services/streaming-tracker-write-queue.js";

type LibraryRow = { anime: AnimeIdentity; entry: AnimeListEntry | undefined };
type NormalizedRow = { anime: AnimeIdentity; entry: AnimeListEntry };
const STATUSES: AnimeStatus[] = ["PLANNING","WATCHING","COMPLETED","ON_HOLD","DROPPED","REWATCHING"];
const STATUS_LABELS: Record<AnimeStatus,string> = {
  PLANNING:"Запланировано", WATCHING:"Смотрю", COMPLETED:"Просмотрено",
  ON_HOLD:"Отложено", DROPPED:"Брошено", REWATCHING:"Пересматриваю",
};

function UnavailableProviderRow({ id, mark, name, detail }: {
  id: "animego" | "anixart";
  mark: string;
  name: string;
  detail: string;
}) {
  return <article className="integration-provider streaming-provider-row" data-provider={id}>
    <div className={"integration-provider-mark integration-provider-mark--" + id} aria-hidden="true"><span>{mark}</span></div>
    <div className="integration-provider-info">
      <h3>{name}</h3>
      <p>{detail}</p>
    </div>
    <div className="integration-state">{id === "animego" ? "API не подтверждён" : "API недоступен"}</div>
    <div className="streaming-provider-actions">
      <button className="add-button" type="button" disabled title="Кнопка станет доступна после появления разрешённого API">Импорт списка</button>
      <button className="secondary-button" type="button" disabled title="Нет подтверждённого API для синхронизации">Синхронизировать</button>
      <button className="secondary-button" type="button" disabled>Отключить</button>
    </div>
  </article>;
}

export function StreamingTrackerPanel({ items, onImport }: {
  items: LibraryRow[];
  onImport: (rows: NormalizedRow[]) => Promise<void>;
  /** Kept temporarily for compatibility with the previous Anixart file-import caller. */
  onImportAnixart: (file: File) => Promise<{ imported: number; skipped: number }>;
}) {
  const [status,setStatus]=useState<YummyAccountStatus|null>(null);
  const [login,setLogin]=useState("");
  const [password,setPassword]=useState("");
  const [captcha,setCaptcha]=useState("");
  const [lists,setLists]=useState<Array<Record<string,unknown>>>([]);
  const [mapping,setMapping]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const [importCount,setImportCount]=useState<number|null>(null);
  const options=useMemo(()=>lists.flatMap(list=>{
    const id=String(list.id??""); const label=String(list.name??list.title??list.label??("Список "+id));
    return ["0","1","2","3","5"].includes(id)?[{value:id,label}]:[];
  }),[lists]);
  async function refresh(){
    const next=await yummyTrackerApi.status(); setStatus(next);
    if(next.connected){const payload=await yummyTrackerApi.lists();setLists(payload.lists);setImportCount(normalizeYummyLists(payload).length);}
  }
  useEffect(()=>{void refresh().catch(e=>setError(e instanceof Error?e.message:"Не удалось проверить YummyAnime."));},[]);
  async function connect(){
    setBusy(true);setError("");setMessage("");
    try{await yummyTrackerApi.login(login,password,captcha.trim()||undefined);setPassword("");setCaptcha("");await refresh();setMessage("Аккаунт YummyAnime подключён.");}
    catch(e){setError(e instanceof Error?e.message:"Не удалось подключить аккаунт.");}
    finally{setBusy(false);}
  }
  async function importList(){
    setBusy(true);setError("");setMessage("");
    try{
      const payload=await yummyTrackerApi.lists();
      const rows=normalizeYummyLists(payload);
      await onImport(rows);
      setImportCount(rows.length);
      if(rows.length){
        setMessage("Импортировано записей: "+rows.length+" из "+(payload.diagnostics?.fetchedRows??payload.entries.length)+" полученных записей.");
      }else{
        const diagnostics=payload.diagnostics;
        const summary=diagnostics?.lists.map(list=>"#"+(list.listId??"?")+" "+(list.label||"без названия")+": "+list.rowCount+(list.skipped?" ("+list.skipped+")":"")+(list.firstRowKeys?.length?" [поля: "+list.firstRowKeys.join(", ")+(list.firstAnimeKeys?.length?"; anime: "+list.firstAnimeKeys.join(", "):"")+(list.firstUserKeys?.length?"; user: "+list.firstUserKeys.join(", "):"")+"]":"")).join("; ");
        setMessage("Распознано 0 записей. API вернуло "+(diagnostics?.fetchedRows??payload.entries.length)+" записей в "+(diagnostics?.definitionsCount??payload.lists.length)+" списках. "+(summary?"Диагностика: "+summary:"Проверь локальный API и формат ответа."));
        console.info("[Mido] YummyAnime safe import diagnostics",diagnostics??{listCount:payload.lists.length,entryCount:payload.entries.length});
      }
    }
    catch(e){setError(e instanceof Error?e.message:"Не удалось импортировать список.");}
    finally{setBusy(false);}
  }
  async function syncStatuses(){
    setBusy(true);setError("");setMessage("");
    try{
      let skipped=0;
      const counts=new Map<string,number>();
      for(const item of items){
        const externalId=item.anime.externalIds.yummyanime;
        if(externalId) counts.set(externalId,(counts.get(externalId)||0)+1);
      }
      const duplicateIds=new Set([...counts].filter(([,count])=>count>1).map(([id])=>id));
      const operations=items.flatMap(item=>{
        const externalId=item.anime.externalIds.yummyanime;
        if(!externalId||!item.entry||duplicateIds.has(externalId)){skipped++;return [];}
        const listId=mapping[item.entry.status];
        return [
          ...(listId?[{externalId,kind:"list" as const,listId:Number(listId)}]:[]),
          ...(item.entry.favorite?[{externalId,kind:"favorite" as const,favorite:true}]:[]),
        ];
      });
      const result=await runConfirmedTrackerWrites(operations,async operation=>{
        if(operation.kind==="list") await yummyTrackerApi.setList(operation.externalId,operation.listId!);
        else await yummyTrackerApi.setFavorite(operation.externalId,Boolean(operation.favorite));
      });
      setMessage("Выполнено операций: "+result.succeeded.length+". Пропущено без ID или записи: "+skipped+"."+(result.failed?" Остановлено на ID "+result.failed.externalId+": "+result.error:result.cancelled?" Операция отменена.":""));
    }catch(e){setError(e instanceof Error?e.message:"Не удалось обновить списки.");}
    finally{setBusy(false);}
  }
  async function disconnect(){
    setBusy(true);setError("");setMessage("");
    try{await yummyTrackerApi.logout();setStatus({...status!,connected:false,username:null});setLists([]);setMessage("Аккаунт отключён.");}
    catch(e){setError(e instanceof Error?e.message:"Не удалось отключить аккаунт.");}
    finally{setBusy(false);}
  }
  return <div className="streaming-provider-list">
    <article className="integration-provider streaming-provider-row streaming-tracker-provider" data-provider="yummyanime">
      <div className="integration-provider-mark integration-provider-mark--yummyanime" aria-hidden="true"><span>YA</span></div>
      <div className="integration-provider-info">
        <h3>YummyAnime</h3>
        <p>{status?.connected?"Подключён аккаунт: "+(status.username||"пользователь"):"Авторизация через API YummyAnime."}{!status?.configured?" Добавь YUMMY_APPLICATION_TOKEN в .env.local.":""}</p>
      </div>
      <div className={"integration-state "+(status?.connected?"connected":"")}>
        {!status?"Проверка...":status.connected?"Подключён":status.configured?"Не подключён":"Не настроен"}
      </div>
      {status?.connected ? <div className="streaming-provider-actions">
        <button className="add-button" disabled={busy} onClick={()=>void importList()}>{busy?"Подождите...":"Импорт списка"}</button>
        <button className="secondary-button" disabled={busy||options.length===0} onClick={()=>void syncStatuses()}>Синхронизировать</button>
        <button className="secondary-button" disabled={busy} onClick={()=>void disconnect()}>Отключить</button>
      </div> : <div className="streaming-provider-actions">
        <button className="add-button" disabled={busy||!status?.configured||!login.trim()||!password} onClick={()=>void connect()}>{busy?"Подключение...":"Подключить"}</button>
      </div>}
    </article>
    {status?.connected && <div className="streaming-provider-expanded">
      <p>Распознано записей: {importCount??"не проверено"}. Импорт и запись выполняются через API. Прогресс эпизодов пока не подтверждён ответом аккаунтного API.</p>
      <div className="streaming-tracker-mapping">
        {STATUSES.map(value=><label key={value}>{STATUS_LABELS[value]}
          <select value={mapping[value]||""} onChange={event=>setMapping(previous=>({...previous,[value]:event.target.value}))}>
            <option value="">Не отправлять</option>
            {options.map(option=><option key={option.value} value={option.value} disabled={Object.entries(mapping).some(([mappedStatus,mappedId])=>mappedId===option.value&&mappedStatus!==value)}>{option.label}</option>)}
          </select>
        </label>)}
      </div>
      <p className="integration-security-note">Отправляются статусы по выбранной карте и добавление в избранное для тайтлов с точным YummyAnime ID. Снятие избранного, прогресс и оценка пока не синхронизируются.</p>
    </div>}
    {!status?.connected && <div className="streaming-provider-login">
      <input value={login} onChange={event=>setLogin(event.target.value)} placeholder="Логин YummyAnime" autoComplete="username"/>
      <input value={password} onChange={event=>setPassword(event.target.value)} placeholder="Пароль" type="password" autoComplete="current-password"/>
      <input value={captcha} onChange={event=>setCaptcha(event.target.value)} placeholder="Ответ hCaptcha, если запрошен" autoComplete="off"/>
    </div>}
    <UnavailableProviderRow id="animego" mark="AG" name="AnimeGO" detail="Каталог и просмотр доступны. Авторизация и управление списком через API пока не подтверждены."/>
    <UnavailableProviderRow id="anixart" mark="AX" name="Anixart" detail="Каталог доступен. Официальный API для сторонней синхронизации не опубликован; CSV/TXT импорт отключён по твоему требованию."/>
    {message&&<p className="streaming-provider-feedback" role="status">{message}</p>}
    {error&&<p className="error-message" role="alert">{error}</p>}
  </div>;
}
