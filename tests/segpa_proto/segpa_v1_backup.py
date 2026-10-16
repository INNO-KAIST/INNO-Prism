"""SegPA prototype — globally optimal piecewise power-law segmentation for PA detection.
log10 I vs log10 P is partitioned into K straight segments by exact dynamic programming
(global optimum over all breakpoint placements, no local minima). K chosen by BIC with an
over-dispersion factor. Steep elements = segments and inter-segment 'bridges' (1 interval,
covers 1-jump). An avalanche regime = element whose slope lower bound exceeds the upper
bounds of both neighbours (S-shape), significant rise. Threshold = intersection of regime
line with the preceding line (bracket reported). PA = regime slope (lower bound if censored)."""
import numpy as np

def prep(P, reps=None, I=None, se=None):
    """Either replicate reads (n,reps) or per-point mean I with standard error se."""
    P=np.asarray(P,float)
    if reps is not None:
        R=np.atleast_2d(np.asarray(reps,float))
        if R.shape[0]!=len(P): R=R.T
        m=np.nanmean(R,1); nr=np.sum(np.isfinite(R),1)
        sd=np.nanstd(R,1,ddof=1) if R.shape[1]>1 else np.sqrt(np.maximum(m,1))
        a=np.nanmedian(sd**2/np.maximum(m,1)); sd=np.sqrt(np.maximum(sd**2, a*np.maximum(m,1)))
        se=sd/np.sqrt(np.maximum(nr,1))
    else:
        m=np.asarray(I,float); se=np.asarray(se,float)
    o=np.argsort(P); P=P[o]; m=m[o]; se=se[o]
    ok=np.isfinite(P)&(P>0)&np.isfinite(m)
    P,m,se=P[ok],m[ok],se[ok]
    # merge near-duplicate setpoints (gap < 0.25 x median gap): effective replicates, not steps
    xx=np.log10(P); g=np.diff(xx); md=np.median(g[g>0]) if np.any(g>0) else 1.0
    Pm,mm,sm=[P[0]],[m[0]],[se[0]]; grp=[[0]]
    for k in range(1,len(P)):
        if xx[k]-np.log10(Pm[-1])<0.25*md:
            idx=grp[-1]+[k]; w=1/np.maximum(se[idx],1e-12)**2
            Pm[-1]=10**np.mean(xx[idx]); mm[-1]=np.sum(w*m[idx])/w.sum(); sm[-1]=1/np.sqrt(w.sum()); grp[-1]=idx
        else:
            Pm.append(P[k]); mm.append(m[k]); sm.append(se[k]); grp.append([k])
    P,m,se=np.array(Pm),np.array(mm),np.array(sm)
    Ipos=np.maximum(m,np.maximum(se,1e-9))      # keep log finite; near-zero points carry their own large sigma
    x=np.log10(P); y=np.log10(Ipos); sy=se/(Ipos*np.log(10))
    return x,y,np.maximum(sy,1e-4),m,se

def _prefix(x,y,w):
    c=lambda v: np.concatenate([[0],np.cumsum(v)])
    return dict(S=c(w),Sx=c(w*x),Sy=c(w*y),Sxx=c(w*x*x),Sxy=c(w*x*y),Syy=c(w*y*y))
def _seg(pf,i,j):  # points i..j inclusive
    g=lambda k: pf[k][j+1]-pf[k][i]
    S,Sx,Sy,Sxx,Sxy,Syy=[g(k) for k in ('S','Sx','Sy','Sxx','Sxy','Syy')]
    D=S*Sxx-Sx*Sx
    if D<=1e-300: return 0.0,np.nan,np.nan,np.nan,None
    b=(S*Sxy-Sx*Sy)/D; a=(Sy-b*Sx)/S
    rss=max(Syy-2*a*Sy-2*b*Sxy+a*a*S+2*a*b*Sx+b*b*Sxx,0.0)
    return rss,a,b,np.sqrt(S/D),(S,Sx,Sxx,D)   # slope SE (unit-variance weights)

def segment(x,y,sy,Kmax=9,minlen=2,K_force=None):
    n=len(x); w=1/sy**2; pf=_prefix(x,y,w)
    C=np.full((n,n),np.inf)
    for i in range(n):
        for j in range(i+minlen-1,n): C[i,j]=_seg(pf,i,j)[0]
    F=np.full((Kmax+1,n),np.inf); arg=np.zeros((Kmax+1,n),int)
    F[1]=C[0]
    for k in range(2,Kmax+1):
        for j in range(n):
            v=F[k-1][:j]+C[np.arange(1,j+1),j] if j>0 else np.array([np.inf])
            t=np.argmin(v); F[k,j]=v[t]; arg[k,j]=t+1
    def back(k):
        b=[];j=n-1
        while k>1: s=arg[k,j]; b.append(s); j=s-1; k-=1
        return sorted(b)
    # over-dispersion from the most flexible model, then BIC
    Kfeas=[k for k in range(1,Kmax+1) if np.isfinite(F[k,n-1])]
    kf=Kfeas[-1]; phi=max(F[kf,n-1]/max(n-(3*kf-1),1),1.0)
    bic={k:F[k,n-1]/phi+(3*k-1)*np.log(n) for k in Kfeas}
    K=min(bic,key=bic.get)
    if K_force is not None: K=K_force
    starts=[0]+back(K); ends=[s-1 for s in starts[1:]]+[n-1]
    segs=[]
    for i,j in zip(starts,ends):
        rss,a,b,se,cv=_seg(pf,i,j); segs.append(dict(i=i,j=j,a=a,b=b,se=se*np.sqrt(phi),cv=cv))
    return segs,phi,K,bic

def analyze(P,reps=None,I=None,se=None,z=2.0,min_rise=0.3,min_prom=3.0,min_ratio=2.0,verbose=False):
    x,y,sy,m,se=prep(P,reps,I,se)
    # isolated whole-setpoint excursions (up-then-back or down-then-back) are not transitions:
    # flag when the point departs from both neighbours by >6 sigma in opposite-sign secants and
    # the neighbours agree with each other. A genuine jump has a persistent level change instead.
    keep=np.ones(len(x),bool); spikes=[]
    for i in range(1,len(x)-1):
        d1=y[i]-y[i-1]; d2=y[i+1]-y[i]; s_=np.sqrt(sy[i]**2+0.5*(sy[i-1]**2+sy[i+1]**2))
        dev=y[i]-0.5*(y[i-1]+y[i+1])
        if np.sign(d1)!=np.sign(d2) and abs(dev)>6*s_ and abs(y[i+1]-y[i-1])<abs(dev)/3:
            keep[i]=False; spikes.append(float(x[i]))
    x,y,sy,m,se=x[keep],y[keep],sy[keep],m[keep],se[keep]
    # local noise, independent of any segmentation (avoids the coarse-fit -> big-tau -> coarse-fit loop):
    # Gasser-type pseudo-residuals, robust rolling scale over 11 points (a kink touches only 1-2 of them)
    tau=0.0
    if len(x)>=7:
        # 3rd differences cancel local quadratic curvature, so a curved (but smooth) S-bend is not mistaken for noise
        e=np.zeros(len(x)); d3=(y[3:]-3*y[2:-1]+3*y[1:-2]-y[:-3])/np.sqrt(20)
        e[1:-2]=d3; e[0]=d3[0]; e[-2:]=d3[-1]
        loc=np.array([1.4826*np.median(np.abs(e[max(0,k-5):k+6])) for k in range(len(x))])
        tau=float(np.median(np.sqrt(np.maximum(loc**2-sy**2,0))))
        sy=np.sqrt(np.maximum(sy**2,loc**2))
    def detect(segs,K):
        phi=1.0
        s_eff=np.sqrt(phi)*sy
        # dark level: first segment flat & low
        s0=segs[0]; dark=None
        if abs(s0['b'])<max(z*s0['se'],0.5) and s0['j']-s0['i']>=3:
            idx=range(s0['i'],s0['j']+1); dark=dict(D=np.mean(m[list(idx)]),sd=np.std(m[list(idx)],ddof=1))
        # element chain: seg, bridge, seg, ...
        el=[]
        for k,s in enumerate(segs):
            el.append(dict(kind='seg',k=k,lo=s['b']-z*s['se'],hi=s['b']+z*s['se'],s=s['b'],
                           x0=x[s['i']],x1=x[s['j']],i=s['i'],j=s['j']))
            if k<len(segs)-1:
                i=s['j']; j=segs[k+1]['i']; h=x[j]-x[i]
                # jump between the two fitted LEVELS (line predictions), not two raw points: averages noise
                def pred(sg,x0):
                    S_,Sx_,Sxx_,D_=sg['cv']; return sg['a']+sg['b']*x0, np.sqrt(max((Sxx_-2*x0*Sx_+x0*x0*S_)/D_,0))
                yl,sl=pred(s,x[i]); yr,sr=pred(segs[k+1],x[j])
                d=yr-yl; sd=np.hypot(sl,sr)
                dr=y[j]-y[i]; sdr=np.hypot(s_eff[i],s_eff[j])     # raw-point secant: the valid (MVT) lower bound
                # corner vs jump: if the two fitted lines meet inside the gap (within their slope uncertainty),
                # the data are consistent with a continuous corner and no discontinuity is claimed
                bl,br_=s['b'],segs[k+1]['b']
                xc=(s['a']-segs[k+1]['a'])/(br_-bl) if br_!=bl else np.inf
                corner = (x[i]-0.5*h) <= xc <= (x[j]+0.5*h)
                el.append(dict(kind='bridge',k=k,lo=(dr-z*sdr)/h,hi=(dr+z*sdr)/h,s=dr/h,x0=x[i],x1=x[j],i=i,j=j,corner=corner,lev=d/h,
                               raw=dr/h,raw_lo=(dr-z*sdr)/h))
        # ---- slope-profile peaks with prominence (global optimum over peaks, noise-robust) ----
        S=np.array([e['s'] for e in el]); LO=np.array([e['lo'] for e in el]); HI=np.array([e['hi'] for e in el])
        N=len(el); regimes=[]
        for p in range(N):
            e=el[p]
            if e['kind']=='bridge' and not (e['lo']>max(HI[p-1],HI[p+1])*0+0 and True): pass
            # left: walk until a higher element (by point value) or boundary; valley = min slope on the way
            def side(step):
                q=p+step; vmin=np.inf; vhi=np.inf
                while 0<=q<N:
                    if LO[q]>S[p]: return vmin,vhi,False     # significantly higher element found
                    if S[q]<vmin: vmin=S[q]
                    vhi=min(vhi,HI[q])   # evidence of a drop: the most certain low element
                    q+=step
                return vmin,vhi,True                          # reached boundary
            lv,lhi,lb=side(-1); rv,rhi,rb=side(+1)
            if not np.isfinite(lv): continue      # left neighbour higher or nothing on the left
            if not np.isfinite(rv) and not rb: continue   # immediately below a higher element: on a slope, not a peak
            right_cens = rb and not np.isfinite(rv)
            if LO[p]<=lhi or (np.isfinite(rv) and LO[p]<=rhi): continue   # not significantly above valleys
            if LO[p]<=1.0: continue
            # physical-size rule (not just statistical): a regime must stand out from its flanks
            # size is judged against the PRE-regime side (what the avalanche rises out of); the post side only
            # has to show a significant drop (checked above) - a shoulder that later rises again is allowed
            if LO[p]-lhi < min_prom: continue
            # size relative to the pre-regime power law (nearest SEGMENT on the left, bridges excluded:
            # a glitch bridge can be negative and would make any ordinary segment look like a peak)
            lseg=[]
            for q in range(p-1,-1,-1):
                if LO[q]>S[p]: break
                if el[q]['kind']=='seg': lseg.append(el[q]['s'])
            base=max(min(lseg) if lseg else lv, 0.0)
            if S[p] < min_ratio*max(base,0.5) or S[p]-base < min_prom: continue
            # distinct-regime rule: on a side that leads to a HIGHER peak, the slope must dip below half of this peak
            if not lb and lv>0.5*S[p]: continue
            if not rb and rv>0.5*S[p]: continue
            flank=max(lv, rv) if np.isfinite(rv) else lv
            half=(S[p]+flank)/2
            a=p
            while a-1>=0 and S[a-1]>half: a-=1
            b=p
            while b+1<N and S[b+1]>half: b+=1
            i0=el[a]['i']; j0=el[b]['j']
            rise=y[j0]-y[i0]
            if rise<min_rise: continue
            # persistence: an avalanche stays lit — the level reached must not collapse right after
            post=y[j0+1:j0+4]
            if len(post) and np.median(post) < y[j0]-0.5*rise: continue
            # local pre-regime law: the fitted segment holding the point just before the regime.
            # A regime must be >= min_ratio x and >= +min_prom steeper than what it rises out of.
            pre=[sg for sg in segs if sg['i']<=i0-1<=sg['j']]
            if pre:
                b0=max(pre[0]['b'],0.0)
                if S[p] < min_ratio*max(b0,0.5) or S[p]-b0 < min_prom: continue
            pk=el[p]; pv=pk['raw'] if pk['kind']=='bridge' else S[p]; plo=pk['raw_lo'] if pk['kind']=='bridge' else LO[p]
            regimes.append(dict(p=p,a=a,b=b,i=i0,j=j0,peak=pv,peak_lo=plo,det_lo=LO[p],peak_kind=el[p]['kind'],
                                prom=S[p]-flank,right_cens=right_cens,rise=rise))
        # overlapping regimes describe the same transition: keep the best-supported peak
        regimes.sort(key=lambda r:-r['peak_lo'])
        kept=[]
        for r in regimes:
            if all(r['j']<k['i'] or r['i']>k['j'] for k in kept): kept.append(r)
        uniq={k:r for k,r in enumerate(kept)}
        out=[]
        for r in uniq.values():
            ii=list(range(r['i'],r['j']+1))
            ww=1/s_eff[ii]**2
            if len(ii)>=2:
                b,a=np.polyfit(x[ii],y[ii],1,w=np.sqrt(ww))
            # preceding line = segment containing point i-1
            pre=[s for s in segs if s['i']<=r['i']-1<=s['j']]
            ps=pre[0] if pre else None
            xt=(ps['a']-a)/(b-ps['b']) if ps is not None and b!=ps['b'] else np.nan
            pa_sig=np.nan
            if dark is not None:
                Dm=dark['D']-3*dark['sd']; jj=[q for q in ii if m[q]-dark['D']>3*max(dark['sd'],se[q])]
                if len(jj)>=2: pa_sig=np.polyfit(x[jj],np.log10(m[jj]-Dm),1)[0]
            lower = len(ii)<=2 or r['peak_kind']=='bridge'
            # threshold bracket: last point still inside the pre-regime band, first point clearly above it
            br=(x[r['i']-1],x[r['i']])
            near_dark = dark is not None and y[r['i']] < np.log10(dark['D'])+1.0
            if near_dark:
                lit=[q for q in range(max(r['i']-2,0),r['j']+1) if m[q]-dark['D']>3*dark['sd']]
                if lit and lit[0]>0: br=(x[lit[0]-1],x[lit[0]])
            head = pa_sig if (near_dark and np.isfinite(pa_sig) and pa_sig>r['peak']) else r['peak']
            out.append(dict(kind=r['peak_kind'],pa=b,peak=r['peak'],pa_lo=r['peak_lo'],pa_darksub=pa_sig,npts=len(ii),
                            x_th=xt,bracket=br,pa_head=head,near_dark=near_dark,x0=x[r['i']],x1=x[r['j']],rise=r['rise'],prom=r['prom'],
                            status=('lower-bound' if lower else 'resolved')+(' / right-censored' if r['right_cens'] else '')))
        out.sort(key=lambda d:-d['pa_lo'])
        return dict(K=K,phi=phi,tau=tau,spikes=spikes,segs=[(round(float(x[s['i']]),3),round(float(x[s['j']]),3),round(float(s['b']),2),round(float(s['se']),2)) for s in segs],
                    dark=dark,regimes=out,el=[(e['kind'][0],round(float(e['s']),1),round(float(e['lo']),1)) for e in el])

    segs0,_,Kbic,_=segment(x,y,sy)
    # scale selection. The DP gives the globally optimal segmentation for EVERY K. We never go finer than
    # BIC supports, and among K <= K_BIC we keep the scale whose best regime has the largest slope LOWER
    # bound. Rationale: the headline is "the steepest straight segment the data can defend"; a staircase of
    # stochastic switching steps is individually indefensible but defensible when viewed as one ruler.
    # candidates from every scale K <= K_BIC; overlapping candidates describe the same transition, so keep
    # the one with the largest slope lower bound (greedy, non-overlapping in log P). Each candidate has
    # already passed every significance/size/persistence rule at its own scale.
    cands=[]; base=None
    for Kc in range(Kbic,1,-1):
        sc=segs0 if Kc==Kbic else segment(x,y,sy,K_force=Kc)[0]
        r2=detect(sc,Kc)
        if base is None: base=r2
        for q in r2['regimes']: q['scale']=Kc; cands.append(q)
    cands.sort(key=lambda q:-q['pa_lo'])
    chosen=[]
    for q in cands:
        gap=2.5*np.median(np.diff(x))   # spans closer than ~2 sampling steps are one transition
        if all(q['x1']+gap<c['x0'] or q['x0']>c['x1']+gap for c in chosen): chosen.append(q)
    res=base; res['regimes']=chosen; res['Kbic']=Kbic
    return res

def show(name,res):
        print(f"== {name}: K={res['K']} tau={res['tau']:.3f} phi={res['phi']:.2f} dark={None if res['dark'] is None else round(res['dark']['D'],1)}")
        print("   slope chain:",res['el'])
        if not res['regimes']: print("   -> no avalanche regime")
        for r in res['regimes']:
            print(f"   -> peak@{r['kind']:6s} peak={r['peak']:.1f}(lo {r['pa_lo']:.1f}) regimePA={r['pa']:.1f} darksub={r['pa_darksub']:.1f} prom={r['prom']:.1f} n={r['npts']} "
                  f"x_th={r['x_th']:.3f} bracket=[{r['bracket'][0]:.3f},{r['bracket'][1]:.3f}] rise={r['rise']:.2f}dec {r['status']}")
