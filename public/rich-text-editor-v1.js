const MARK_ORDER=['bold','italic','underline','strike','code'];

function markOrder(marks=[]){
  const found=new Set(marks.map(mark=>mark?.type).filter(Boolean));
  return MARK_ORDER.filter(type=>found.has(type)).map(type=>({type}));
}

function mergeText(nodes){
  const out=[];
  for(const node of nodes){
    const previous=out.at(-1);
    if(node?.type==='text'&&!node.text)continue;
    if(node?.type==='text'&&previous?.type==='text'&&JSON.stringify(previous.marks)===JSON.stringify(node.marks)){
      previous.text+=node.text;
    }else out.push(node);
  }
  return out;
}

export function plainTextToRichDocument(text=''){
  const value=String(text);
  return value?{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:value,marks:[]}]}]}:{type:'doc',content:[]};
}

function normalizeText(node){
  return {type:'text',text:String(node?.text??''),marks:markOrder(node?.marks||[])};
}

function normalizeInline(node){
  if(node?.type==='text')return normalizeText(node);
  if(node?.type==='hard_break')return {type:'hard_break'};
  if(node?.type==='link'){
    const href=String(node?.attrs?.href||'');
    const title=node?.attrs?.title===undefined?undefined:String(node.attrs.title);
    const content=mergeText((Array.isArray(node.content)?node.content:[]).filter(item=>item?.type==='text').map(normalizeText));
    return {type:'link',attrs:title===undefined?{href}:{href,title},content};
  }
  return null;
}

function normalizeBlock(node){
  if(node?.type==='paragraph')return {type:'paragraph',content:mergeText((node.content||[]).map(normalizeInline).filter(Boolean))};
  if(node?.type==='code_block'){
    return {type:'code_block',content:(node.content||[]).map(item=>item?.type==='hard_break'?{type:'hard_break'}:normalizeText({...item,marks:[]})).filter(item=>item.type!=='text'||item.text)};
  }
  if(node?.type==='blockquote')return {type:'blockquote',content:(node.content||[]).map(normalizeBlock).filter(Boolean)};
  if(node?.type==='list_item')return {type:'list_item',content:(node.content||[]).map(normalizeBlock).filter(Boolean)};
  if(node?.type==='bullet_list'||node?.type==='ordered_list'){
    return {type:node.type,content:(node.content||[]).filter(item=>item?.type==='list_item').map(normalizeBlock).filter(Boolean)};
  }
  return null;
}

export function normalizeRichDocument(document){
  if(!document||document.type!=='doc'||!Array.isArray(document.content))return {type:'doc',content:[]};
  return {type:'doc',content:document.content.map(normalizeBlock).filter(node=>node&&node.type!=='list_item')};
}

function inlinePlain(nodes=[]){
  return nodes.map(node=>{
    if(node.type==='text')return node.text;
    if(node.type==='hard_break')return '\n';
    const label=(node.content||[]).map(item=>item.text).join('');
    return label===node.attrs.href?node.attrs.href:`${label} (${node.attrs.href})`;
  }).join('');
}

function indentContinuation(value,prefix){
  return String(value).split('\n').map((line,index)=>index===0?`${prefix}${line}`:`${' '.repeat(prefix.length)}${line}`).join('\n');
}

function blockPlain(node){
  if(node.type==='paragraph')return inlinePlain(node.content);
  if(node.type==='code_block')return (node.content||[]).map(item=>item.type==='hard_break'?'\n':item.text).join('');
  if(node.type==='blockquote')return (node.content||[]).map(blockPlain).join('\n\n').split('\n').map(line=>`> ${line}`).join('\n');
  if(node.type==='list_item')return (node.content||[]).map(blockPlain).join('\n');
  if(node.type==='bullet_list')return (node.content||[]).map(item=>indentContinuation(blockPlain(item),'• ')).join('\n');
  if(node.type==='ordered_list')return (node.content||[]).map((item,index)=>indentContinuation(blockPlain(item),`${index+1}. `)).join('\n');
  return '';
}

export function richDocumentToPlain(document){
  return normalizeRichDocument(document).content.map(blockPlain).join('\n\n');
}

function safeHref(value){
  try{
    const url=new URL(String(value));
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
    return url.href;
  }catch{return null;}
}

function appendMarkedText(parent,node){
  let current=document.createTextNode(node.text);
  const wrappers={
    bold:'strong',
    italic:'em',
    underline:'u',
    strike:'s',
    code:'code'
  };
  for(const mark of markOrder(node.marks).slice().reverse()){
    const wrapper=document.createElement(wrappers[mark.type]);
    wrapper.append(current);
    current=wrapper;
  }
  parent.append(current);
}

function appendInline(parent,node){
  if(node.type==='text'){appendMarkedText(parent,node);return;}
  if(node.type==='hard_break'){parent.append(document.createElement('br'));return;}
  if(node.type==='link'){
    const href=safeHref(node.attrs?.href);
    if(!href){
      for(const item of node.content||[])appendMarkedText(parent,item);
      return;
    }
    const link=document.createElement('a');
    link.href=href;
    link.target='_blank';
    link.rel='noopener noreferrer';
    if(node.attrs?.title)link.title=String(node.attrs.title);
    for(const item of node.content||[])appendMarkedText(link,item);
    parent.append(link);
  }
}

function blockElement(node){
  if(node.type==='paragraph'){
    const element=document.createElement('p');
    for(const child of node.content||[])appendInline(element,child);
    if(!element.childNodes.length)element.append(document.createElement('br'));
    return element;
  }
  if(node.type==='blockquote'){
    const element=document.createElement('blockquote');
    for(const child of node.content||[])element.append(blockElement(child));
    return element;
  }
  if(node.type==='bullet_list'||node.type==='ordered_list'){
    const element=document.createElement(node.type==='bullet_list'?'ul':'ol');
    for(const item of node.content||[])element.append(blockElement(item));
    return element;
  }
  if(node.type==='list_item'){
    const element=document.createElement('li');
    for(const child of node.content||[])element.append(blockElement(child));
    return element;
  }
  if(node.type==='code_block'){
    const pre=document.createElement('pre');
    const code=document.createElement('code');
    for(const item of node.content||[]){
      if(item.type==='hard_break')code.append(document.createTextNode('\n'));
      else code.append(document.createTextNode(item.text));
    }
    pre.append(code);
    return pre;
  }
  return document.createElement('p');
}

export function renderRichText(host,documentValue){
  host.replaceChildren();
  const normalized=normalizeRichDocument(documentValue);
  for(const block of normalized.content)host.append(blockElement(block));
  return normalized;
}

function inheritedMarks(element,marks){
  const tag=element.tagName?.toLowerCase();
  const next=[...marks];
  const map={strong:'bold',b:'bold',em:'italic',i:'italic',u:'underline',s:'strike',strike:'strike',del:'strike',code:'code'};
  if(map[tag])next.push({type:map[tag]});
  return markOrder(next);
}

function inlineFromDom(node,marks=[]){
  if(node.nodeType===Node.TEXT_NODE)return node.nodeValue?[{type:'text',text:node.nodeValue,marks:markOrder(marks)}]:[];
  if(node.nodeType!==Node.ELEMENT_NODE)return[];
  const element=node;
  const tag=element.tagName.toLowerCase();
  if(tag==='br')return[{type:'hard_break'}];
  if(tag==='a'){
    const href=safeHref(element.getAttribute('href')||'');
    if(!href)return [...element.childNodes].flatMap(child=>inlineFromDom(child,marks));
    const content=mergeText([...element.childNodes].flatMap(child=>inlineFromDom(child,marks)).map(item=>{
      if(item.type==='hard_break')return {type:'text',text:'\n',marks:markOrder(marks)};
      if(item.type==='link')return {type:'text',text:richDocumentToPlain({type:'doc',content:[{type:'paragraph',content:[item]}]}),marks:markOrder(marks)};
      return item;
    }).filter(item=>item.type==='text'));
    const title=element.getAttribute('title');
    return[{type:'link',attrs:title?{href,title}:{href},content}];
  }
  const nextMarks=inheritedMarks(element,marks);
  return [...element.childNodes].flatMap(child=>inlineFromDom(child,nextMarks));
}

function directInlineBlock(element){
  return {type:'paragraph',content:mergeText([...element.childNodes].flatMap(child=>inlineFromDom(child,[])))};
}

function blockFromDom(element){
  const tag=element.tagName?.toLowerCase();
  if(tag==='p'||tag==='div')return directInlineBlock(element);
  if(tag==='pre'){
    const text=element.textContent||'';
    const parts=text.split('\n');
    const content=[];
    parts.forEach((part,index)=>{
      if(part)content.push({type:'text',text:part,marks:[]});
      if(index<parts.length-1)content.push({type:'hard_break'});
    });
    return {type:'code_block',content};
  }
  if(tag==='blockquote'){
    const blocks=[...element.children].map(blockFromDom).filter(Boolean);
    return {type:'blockquote',content:blocks.length?blocks:[directInlineBlock(element)]};
  }
  if(tag==='ul'||tag==='ol'){
    return {type:tag==='ul'?'bullet_list':'ordered_list',content:[...element.children]
      .filter(child=>child.tagName?.toLowerCase()==='li').map(blockFromDom).filter(Boolean)};
  }
  if(tag==='li'){
    const blockChildren=[...element.children].filter(child=>['p','div','blockquote','ul','ol','pre'].includes(child.tagName.toLowerCase()));
    const content=blockChildren.length?blockChildren.map(blockFromDom).filter(Boolean):[directInlineBlock(element)];
    return {type:'list_item',content};
  }
  return null;
}

function documentFromSurface(surface){
  const content=[];
  let loose=[];
  const flushLoose=()=>{
    if(!loose.length)return;
    content.push({type:'paragraph',content:mergeText(loose.flatMap(node=>inlineFromDom(node,[])))});
    loose=[];
  };
  for(const node of surface.childNodes){
    if(node.nodeType===Node.ELEMENT_NODE&&['p','div','blockquote','ul','ol','pre'].includes(node.tagName.toLowerCase())){
      flushLoose();
      const block=blockFromDom(node);
      if(block)content.push(block);
    }else loose.push(node);
  }
  flushLoose();
  return normalizeRichDocument({type:'doc',content});
}

function insertTextAtSelection(text){
  if(document.queryCommandSupported?.('insertText')){
    document.execCommand('insertText',false,text);
    return;
  }
  const selection=window.getSelection();
  if(!selection?.rangeCount)return;
  const range=selection.getRangeAt(0);
  range.deleteContents();
  const node=document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function wrapSelection(tag){
  const selection=window.getSelection();
  if(!selection?.rangeCount||selection.isCollapsed)return;
  const range=selection.getRangeAt(0);
  const wrapper=document.createElement(tag);
  try{range.surroundContents(wrapper);}catch{
    const contents=range.extractContents();
    wrapper.append(contents);
    range.insertNode(wrapper);
  }
  selection.removeAllRanges();
  const next=document.createRange();
  next.selectNodeContents(wrapper);
  selection.addRange(next);
}

const TOOLBAR=[
  ['bold','Жирный','Ж'],
  ['italic','Курсив','К'],
  ['underline','Подчёркнутый','П'],
  ['strike','Зачёркнутый','З'],
  ['code','Inline code','</>'],
  ['link','Ссылка','↗'],
  ['quote','Цитата','❝'],
  ['bullet','Маркированный список','•'],
  ['ordered','Нумерованный список','1.'],
  ['codeblock','Блок кода','{ }'],
  ['break','Перенос строки','↵'],
  ['emoji','Вставить emoji','🙂']
];

export function mountRichTextEditor(host,{document:initialDocument,onChange,disabled=false}={}){
  host.replaceChildren();
  host.classList.add('rich-text-editor');
  const toolbar=document.createElement('div');
  toolbar.className='rich-text-toolbar';
  toolbar.setAttribute('role','toolbar');
  toolbar.setAttribute('aria-label','Форматирование текста');
  for(const [command,label,text] of TOOLBAR){
    const button=document.createElement('button');
    button.type='button';
    button.dataset.richCommand=command;
    button.setAttribute('aria-label',label);
    button.title=label;
    button.textContent=text;
    toolbar.append(button);
  }
  const surface=document.createElement('div');
  surface.className='rich-text-surface';
  surface.contentEditable=disabled?'false':'true';
  surface.setAttribute('role','textbox');
  surface.setAttribute('aria-multiline','true');
  surface.setAttribute('aria-label','Основной текст публикации');
  surface.spellcheck=true;
  host.append(toolbar,surface);

  renderRichText(surface,initialDocument||{type:'doc',content:[]});

  const changed=()=>{
    const value=documentFromSurface(surface);
    onChange?.(value,richDocumentToPlain(value));
  };
  surface.addEventListener('input',changed);
  surface.addEventListener('paste',event=>{
    event.preventDefault();
    insertTextAtSelection(event.clipboardData?.getData('text/plain')||'');
    changed();
  });
  surface.addEventListener('drop',event=>{
    event.preventDefault();
    insertTextAtSelection(event.dataTransfer?.getData('text/plain')||'');
    changed();
  });
  surface.addEventListener('keydown',event=>{
    if(!(event.ctrlKey||event.metaKey))return;
    const key=event.key.toLowerCase();
    const command=key==='b'?'bold':key==='i'?'italic':key==='u'?'underline':null;
    if(!command)return;
    event.preventDefault();
    document.execCommand(command,false);
    changed();
  });

  toolbar.addEventListener('mousedown',event=>event.preventDefault());
  toolbar.addEventListener('click',event=>{
    const button=event.target.closest('button[data-rich-command]');
    if(!button||button.disabled)return;
    const command=button.dataset.richCommand;
    surface.focus();
    if(command==='bold'||command==='italic'||command==='underline')document.execCommand(command,false);
    else if(command==='strike')document.execCommand('strikeThrough',false);
    else if(command==='bullet')document.execCommand('insertUnorderedList',false);
    else if(command==='ordered')document.execCommand('insertOrderedList',false);
    else if(command==='quote')document.execCommand('formatBlock',false,'blockquote');
    else if(command==='codeblock')document.execCommand('formatBlock',false,'pre');
    else if(command==='break')document.execCommand('insertLineBreak',false);
    else if(command==='emoji')insertTextAtSelection('🙂');
    else if(command==='code')wrapSelection('code');
    else if(command==='link'){
      const href=window.prompt('https://…','https://');
      if(href){
        const safe=safeHref(href);
        if(!safe)window.alert('Разрешены только безопасные http/https ссылки без логина и пароля.');
        else document.execCommand('createLink',false,safe);
      }
    }
    changed();
  });

  const api={
    getDocument:()=>documentFromSurface(surface),
    getPlainText:()=>richDocumentToPlain(documentFromSurface(surface)),
    setDocument(value){renderRichText(surface,value);changed();},
    setDisabled(value){
      surface.contentEditable=value?'false':'true';
      toolbar.querySelectorAll('button').forEach(button=>{button.disabled=Boolean(value);});
      host.classList.toggle('disabled',Boolean(value));
    },
    focus:()=>surface.focus(),
    surface,
    toolbar
  };
  host.richTextEditor=api;
  api.setDisabled(disabled);
  changed();
  return api;
}

window.PublikatorRichText={mountRichTextEditor,renderRichText,plainTextToRichDocument,richDocumentToPlain,normalizeRichDocument};
