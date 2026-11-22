import { useEffect, useMemo, useState } from "react";
import type { AnimeIdentity, AnimeListEntry, AnimeStatus } from "../core/types.js";
import { normalizeYummyLists, yummyTrackerApi, type YummyAccountStatus } from "../services/streaming-tracker-api.js";
import { getStreamingTrackerCapabilities } from "../services/streaming-tracker-registry.js";
import { runConfirmedTrackerWrites } from "../services/streaming-tracker-write-queue.js";

type LibraryRow = { anime: AnimeIdentity; entry: AnimeListEntry | undefined };
type NormalizedRow = { anime: AnimeIdentity; entry: AnimeListEntry };
const STATUSES: AnimeStatus[] = ["PLANNING","WATCHING","COMPLETED","ON_HOLD","DROPPED","REWATCHING"];
const STATUS_LABELS: Record<AnimeStatus,string> = {
  PLANNING:"Запланировано", WATCHING:"Смотрю", COMPLETED:"Просмотрено",
  ON_HOLD:"Отложено", DROPPED:"Брошено", REWATCHING:"Пересматриваю",
};
export function StreamingTrackerPanel({ items, onImport }: {
  items: LibraryRow[];
  onImport: (rows: NormalizedRow[]) => Promise<void>;
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
    return id?[{value:id,label}]:[];
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
    try{const payload=await yummyTrackerApi.lists();const rows=normalizeYummyLists(payload);await onImport(rows);setImportCount(rows.length);setMessage("Импортировано записей: "+rows.length+".");}
    catch(e){setError(e instanceof Error?e.message:"Не удалось импортировать список.");}
    finally{setBusy(false);}
  }
  async function syncStatuses(){
    setBusy(true);setError("");setMessage("");
    try{
      let skipped=0;
      const operations=items.flatMap(item=>{
        const externalId=item.anime.externalIds.yummyanime;
        if(!externalId||!item.entry){skipped++;return [];}
        const listId=mapping[item.entry.status];
        return [
          ...(listId?[{externalId,kind:"list" as const,listId:Number(listId)}]:[]),
          ...(item.entry.favorite?[{externalId,kind:"favorite" as const,favorite:true}]:[]),
        ];
      });
      const result=await runConfirmedTrackerWrites(operations,operation=>
        operation.kind==="list"
          ? yummyTrackerApi.setList(operation.externalId,operation.listId!)
          : yummyTrackerApi.setFavorite(operation.externalId,Boolean(operation.favorite))
      );
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
  return <section className="integration-provider streaming-tracker-provider">
    <div className="integration-provider-info">
      <h3>YummyAnime · синхронизация списков</h3>
      <p>{status?.connected?"Подключён аккаунт: "+(status.username||"пользователь"):"Подключение через локальный API. Пароль не сохраняется в интерфейсе."}</p>
      {!status?.configured&&<p>Для работы добавь YUMMY_APPLICATION_TOKEN в .env.local.</p>}
    </div>
    {status?.connected?<>
      <div className="integration-state connected">Подключён</div>
      <div className="streaming-tracker-actions">
        <button className="add-button" disabled={busy} onClick={()=>void importList()}>{busy?"Подождите...":"Импортировать список"}</button>
        <button className="secondary-button" disabled={busy||options.length===0} onClick={()=>void syncStatuses()}>Отправить статусы и избранное</button>
        <button className="secondary-button" disabled={busy} onClick={()=>void disconnect()}>Отключить</button>
      </div>
      <p>Найдено распознанных записей: {importCount??"не проверено"}. Для отправки статусов сначала вручную сопоставь статусы приложения со списками сайта.</p>
      <div className="streaming-tracker-mapping">
        {STATUSES.map(value=><label key={value}>{STATUS_LABELS[value]}
          <select value={mapping[value]||""} onChange={event=>setMapping(previous=>({...previous,[value]:event.target.value}))}>
            <option value="">Не отправлять</option>
            {options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>)}
      </div>
      <p className="integration-security-note">Отправляются статусы по выбранной карте и добавление в избранное для тайтлов с точным YummyAnime ID. Снятие избранного, прогресс и оценка пока не синхронизируются. Не назначай один список нескольким статусам, если не хочешь неоднозначных результатов.</p>
    </>:<>
      <div className="streaming-tracker-login">
        <input value={login} onChange={event=>setLogin(event.target.value)} placeholder="Логин YummyAnime" autoComplete="username"/>
        <input value={password} onChange={event=>setPassword(event.target.value)} placeholder="Пароль" type="password" autoComplete="current-password"/>
        <input value={captcha} onChange={event=>setCaptcha(event.target.value)} placeholder="Ответ hCaptcha, если запрошен" autoComplete="off"/>
        <button className="add-button" disabled={busy||!status?.configured||!login.trim()||!password} onClick={()=>void connect()}>{busy?"Подключение...":"Подключить"}</button>
      </div>
    </>}
    <div className="streaming-tracker-provider-limitations">
      <h4>Другие площадки</h4>
      <p><strong>AnimeGO:</strong> {getStreamingTrackerCapabilities("animego").reason}</p>
      <p><strong>Anixart:</strong> {getStreamingTrackerCapabilities("anixart").reason}</p>
    </div>
    {message&&<p role="status">{message}</p>}
    {error&&<p className="error-message" role="alert">{error}</p>}
  </section>;
}
