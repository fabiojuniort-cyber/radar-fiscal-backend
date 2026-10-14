/** One background refresh at a time; reads never wait for an archive scan. */
export class InventoryCache<T> {
  private value:T[]=[];
  private readyKey:string|null=null;
  private pending:Promise<void>|null=null;
  private checkedAt=0;
  private failed=false;
  private closed=false;
  constructor(private readonly key:()=>Promise<string>,private readonly build:()=>Promise<T[]>,
    private readonly now=Date.now,private readonly intervalMs=15_000){}
  read(force=false) {
    if(!this.closed&&!this.pending&&(force||!this.checkedAt||this.now()-this.checkedAt>=this.intervalMs)) {
      this.pending=Promise.resolve().then(async()=>{
        try {
          const key=await this.key();
          if(key!==this.readyKey){
            const items=await this.build();
            // Do not label a mixed-policy/collection snapshot current.
            if(await this.key()!==key){this.checkedAt=0;return;}
            this.value=items;this.readyKey=key;
          }
          this.failed=false;this.checkedAt=this.now();
        }catch{this.failed=true;this.checkedAt=this.now();}
      }).finally(()=>{this.pending=null;});
    }
    return {items:this.value,inventory:{status:this.failed?'FAILED' as const:
      this.readyKey===null?'WARMING' as const:this.pending?'REFRESHING' as const:'READY' as const,
      key:this.readyKey}};
  }
  async settled(){await this.pending;}
  async close(){this.closed=true;await this.pending;}
}
