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
export function StreamingTrackerPanel({ items, onImport, onImportAnixart }: {
  items: LibraryRow[];
  onImport: (rows: NormalizedRow[]) => Promise<void>;
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
  async function importAnixartFile(file:File){
    setBusy(true);setError("");setMessage("");
    try{
      const result=await onImportAnixart(file);
      setMessage("Предпросмотр Anixart готов: "+result.imported+" записей, пропущено: "+result.skipped+". Проверь сопоставления в блоке импорта и подтверди перенос.");
    }catch(e){setError(e instanceof Error?e.message:"Не удалось прочитать экспорт Anixart.");}
    finally{setBusy(false);}
  }
  async function disconnect(){
    setBusy(true);setError("");setMessage("");
    try{await yummyTrackerApi.logout();setStatus({...status!,connected:false,username:null});setLists([]);setMessage("Аккаунт отключён.");}
    catch(e){setError(e instanceof Error?e.message:"Не удалось отключить аккаунт.");}
    finally{setBusy(false);}
  }
  return <section className="integration-provider streaming-tracker-provider">
    <div className="streaming-tracker-account-header">
      <div className="integration-provider-mark integration-provider-mark--yummyanime" aria-hidden="true"><span>YA</span></div>
      <div className="integration-provider-info">
      <h3>YummyAnime · синхронизация списков</h3>
      <p>{status?.connected?"Подключён аккаунт: "+(status.username||"пользователь"):"Подключение через локальный API. Пароль не сохраняется в интерфейсе."}</p>
      {!status?.configured&&<p>Для работы добавь YUMMY_APPLICATION_TOKEN в .env.local.</p>}
      </div>
      {status?.connected&&<div className="integration-state connected">Подключён</div>}
      {status&&!status.connected&&<div className="integration-state">{status.configured?"Не подключён":"Не настроен"}</div>}
    </div>
    {status?.connected?<>
      <div className="streaming-tracker-actions">
        <button className="add-button" disabled={busy} onClick={()=>void importList()}>{busy?"Подождите...":"Импорт списка"}</button>
        <button className="secondary-button" disabled={busy||options.length===0} onClick={()=>void syncStatuses()}>Синхронизировать</button>
        <button className="secondary-button" disabled={busy} onClick={()=>void disconnect()}>Отключить</button>
      </div>
      <p>Найдено распознанных записей: {importCount??"не проверено"}. {importCount ? "Чтобы отправлять статусы на сайт, вручную сопоставь статусы приложения со списками YummyAnime ниже." : "Нажми «Импортировать список», чтобы получить записи из аккаунта."}</p>
      <div className="streaming-tracker-mapping">
        {STATUSES.map(value=><label key={value}>{STATUS_LABELS[value]}
          <select value={mapping[value]||""} onChange={event=>setMapping(previous=>({...previous,[value]:event.target.value}))}>
            <option value="">Не отправлять</option>
            {options.map(option=><option key={option.value} value={option.value} disabled={Object.entries(mapping).some(([mappedStatus,mappedId])=>mappedId===option.value&&mappedStatus!==value)}>{option.label}</option>)}
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
      <h4>Импорт других площадок</h4>
      <p><strong>AnimeGO:</strong> {getStreamingTrackerCapabilities("animego").reason}</p>
      <p><strong>Anixart:</strong> официальный экспорт закладок CSV или TXT. Пароль и API не нужны.</p>
      <label className="streaming-tracker-import-file">
        <span>{busy?"Обработка файла...":"Выбрать экспорт Anixart (.csv или .txt)"}</span>
        <input type="file" accept=".csv,.txt,text/csv,text/plain" disabled={busy} onChange={event=>{const file=event.target.files?.[0];if(file)void importAnixartFile(file);event.currentTarget.value="";}}/>
      </label>
      <p className="integration-security-note">В Anixart: Настройки → Данные и память → Экспорт закладок. Выбери нужные списки и включи «Оригинальное название», «Альтернативные названия», «Статус просмотра» и «Моя оценка». Избранное переносится отдельной отметкой. Официальный экспорт не содержит прогресс по эпизодам.</p>
    </div>
    {message&&<p role="status">{message}</p>}
    {error&&<p className="error-message" role="alert">{error}</p>}
  </section>;
}
