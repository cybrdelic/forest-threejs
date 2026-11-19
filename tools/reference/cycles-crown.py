"""Run with blender -b -t 2 -P tools/reference/cycles-crown.py -- output-dir [samples].
The offline solver shares the raster's authored geometry, camera, sun, and
photographic pigment. It independently traces leaf visibility and diffuse,
glossy and translucent paths without importing raster lighting or shadow maps.
"""
import bpy,json,math,os,sys
from pathlib import Path
import numpy as np
from mathutils import Vector
args=sys.argv[sys.argv.index('--')+1:];out=Path(args[0]);spp=int(args[1]) if len(args)>1 else 64
assets=Path(__file__).resolve().parents[2]/'dist/assets'
fixture=json.loads((out/'scene.json').read_text())
# Disable thin transmission only in the optional matched ablation. This also
# changes later leaf-to-leaf transport. Cycles groups diffuse translucency in
# its diffuse passes, so an ordinary transmission render pass cannot isolate it.
transmission_scale=float(os.getenv('FOREST_REFERENCE_TRANSMISSION','1'))
if transmission_scale not in (0,1):raise ValueError('Use 0 or 1 for transmission ablation')
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.device='CPU'
scene.cycles.samples=spp;scene.cycles.use_adaptive_sampling=False;scene.cycles.use_denoising=False
scene.cycles.max_bounces=6;scene.cycles.transparent_max_bounces=32
scene.render.resolution_percentage=100;scene.render.resolution_x=fixture['width'];scene.render.resolution_y=fixture['height']
scene.render.film_transparent=True
scene.render.image_settings.file_format='OPEN_EXR';scene.render.image_settings.color_depth='32';scene.render.image_settings.color_mode='RGBA'

def blender_xyz(p):
    v=np.array(p,dtype=np.float32)
    return np.stack((v[...,0],-v[...,2],v[...,1]),axis=-1)
def image(name,rgb):
    h,w=rgb.shape[:2];im=bpy.data.images.new(name,width=w,height=h,alpha=True,float_buffer=True)
    im.colorspace_settings.name='Non-Color';im.alpha_mode='CHANNEL_PACKED'
    pixels=np.ones((h,w,4),dtype='f');pixels[:,:,:rgb.shape[-1]]=rgb
    im.pixels.foreach_set(pixels.ravel());im.update();return im
def mesh(name,positions,indices,materials,uv=None,normals=None,face_material=None):
    positions=np.ascontiguousarray(positions,dtype='f');indices=np.ascontiguousarray(indices,dtype='i').reshape(-1,3)
    m=bpy.data.meshes.new(name)
    m.vertices.add(len(positions));m.vertices.foreach_set('co',positions.ravel())
    m.loops.add(indices.size);m.loops.foreach_set('vertex_index',indices.ravel())
    m.polygons.add(len(indices));m.polygons.foreach_set('loop_start',np.arange(0,indices.size,3,dtype='i'))
    for material in materials:m.materials.append(material)
    if face_material is not None:m.polygons.foreach_set('material_index',np.ascontiguousarray(face_material,dtype='i'))
    m.update(calc_edges=True)
    if normals is not None:
        m.polygons.foreach_set('use_smooth',np.ones(len(indices),dtype=bool))
        m.normals_split_custom_set_from_vertices(normals.tolist())
    if uv is not None:
        m.uv_layers.new(name='Source UV').uv.foreach_set('vector',np.ascontiguousarray(uv[indices.ravel()],dtype='f').ravel())
    obj=bpy.data.objects.new(name,m);scene.collection.objects.link(obj);return obj

albedo=np.memmap(assets/'albedo.bin',dtype='u1',mode='r',shape=(9,512,512,4))
normals=np.memmap(assets/'normal.bin',dtype='u1',mode='r',shape=(9,512,512,4))
def leaf_texture(layer,pigment):
    cc=np.asarray(albedo[layer],dtype='f')/255
    alpha=np.asarray(normals[layer,:,:,3],dtype='f')/255
    rgb=np.where(cc[:,:,:3]<=.04045,cc[:,:,:3]/12.92,((cc[:,:,:3]+.055)/1.055)**2.4)
    rgb=rgb/np.maximum(alpha[:,:,None],1/255)*pigment
    return image('Source reflected pigment',np.dstack((rgb.clip(0,.95),alpha)))
def material(name):
    m=bpy.data.materials.new(name);m.use_nodes=True;m.node_tree.nodes.clear()
    return m,m.node_tree.nodes.new,m.node_tree.links.new
def link_color(link,a,b):link(a.outputs[0],b.inputs['Color'])
def normal_texture(layer):
    source=np.asarray(normals[layer],dtype='f')/255
    if (assets/'foliage-normal-moments.json').exists():
        a=source[:,:,3:4]
        moment=(source[:,:,:3]*2-1-(1-a)*[0,0,1])/np.maximum(a,1/255)
        rgb=(.5+.5*moment).clip(0,1)
    else:rgb=source[:,:,:3]
    return image('Covered tangent normal '+str(layer),rgb)

is_meadow=fixture.get('kind')=='meadow'
if not is_meadow:
    tx,ty,tz,scale,yaw,phenotype,width,_=fixture['tree']
    v=np.fromfile(out/'tree.f32',dtype='<f4').reshape(-1,12)
    indices=np.fromfile(out/'tree.u32',dtype='<u4').reshape(-1,3)
    def rotate(xyz):
        ret=xyz.copy();ret[:,0]=xyz[:,0]*math.cos(yaw)+xyz[:,2]*math.sin(yaw)
        ret[:,2]=-xyz[:,0]*math.sin(yaw)+xyz[:,2]*math.cos(yaw);return ret
    pos=rotate(v[:,:3])*scale;pos[:,[0,2]]*=.78+.48*width;pos+=[tx,ty,tz]
    nn=rotate(v[:,3:6]);nn[:,1]*=.78+.48*width;nn/=np.maximum(np.linalg.norm(nn,axis=1,keepdims=True),1e-6)
    sp=fixture['species'];point=np.clip((phenotype-.2)/.6,0,1);factor=(.5-point**2*(3-2*point))*.30
    source=np.array([.18908,.20851,.05683] if sp=='jacaranda' else [.12612,.18051,.04922])
    layer=4 if sp=='jacaranda' else 3
    leaf,new,link=material('Photographed thin leaf')
    tex=new('ShaderNodeTexImage');tex.image=leaf_texture(layer,.85*source**factor)
    micro=new('ShaderNodeTexImage');micro.image=normal_texture(layer)
    bump=new('ShaderNodeNormalMap');bump.inputs['Strength'].default_value=.65;link(micro.outputs['Color'],bump.inputs['Color'])
    base=new('ShaderNodeBsdfPrincipled');link(tex.outputs['Color'],base.inputs['Base Color'])
    base.inputs['Roughness'].default_value=.66;base.inputs['IOR'].default_value=1.5;link(bump.outputs[0],base.inputs['Normal'])
    # The reference uses independent diffuse leaf transmission in addition to a
    # dielectric top surface. Clamp the transmitted pigment to the runtime budget.
    atten=new('ShaderNodeVectorMath');atten.operation='SCALE';link(tex.outputs['Color'],atten.inputs[0]);atten.inputs['Scale'].default_value=.32*.96*transmission_scale
    remaining=new('ShaderNodeVectorMath');remaining.operation='SUBTRACT';remaining.inputs[0].default_value=(.95,.95,.95);link(tex.outputs['Color'],remaining.inputs[1])
    bounded=new('ShaderNodeVectorMath');bounded.operation='MINIMUM';link(remaining.outputs[0],bounded.inputs[0]);link(atten.outputs[0],bounded.inputs[1])
    trans=new('ShaderNodeBsdfTranslucent');link(bounded.outputs[0],trans.inputs['Color']);link(bump.outputs[0],trans.inputs['Normal'])
    combined=new('ShaderNodeAddShader');link(base.outputs[0],combined.inputs[0]);link(trans.outputs[0],combined.inputs[1])
    alpha=new('ShaderNodeMixShader');link(tex.outputs['Alpha'],alpha.inputs[0]);link(new('ShaderNodeBsdfTransparent').outputs[0],alpha.inputs[1]);link(combined.outputs[0],alpha.inputs[2])
    link(alpha.outputs[0],new('ShaderNodeOutputMaterial').inputs['Surface'])
    bark,new,link=material('Source trunk bark')
    bc=np.asarray(albedo[2,:,:,:3],dtype='f')/255;bc=np.where(bc<=.04045,bc/12.92,((bc+.055)/1.055)**2.4)
    tex=new('ShaderNodeTexImage');tex.image=image('Bark reflectance',bc*.9)
    bsdf=new('ShaderNodeBsdfPrincipled');link(tex.outputs['Color'],bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value=.85;link(bsdf.outputs[0],new('ShaderNodeOutputMaterial').inputs['Surface'])
    uv=v[:,10:12].copy();wood=v[:,9]<1.5;uv[wood,0]=(pos[wood,0]+pos[wood,2])*1.5;uv[wood,1]=pos[wood,1]*.65
    tree=mesh('Solitary pasture specimen',blender_xyz(pos),indices,[bark,leaf],uv,blender_xyz(nn),v[indices[:,0],9]>4.5)
else:
    tx,ty,tz=fixture['target']
    v=np.fromfile(out/'plants.f32',dtype='<f4').reshape(-1,12)
    indices=np.fromfile(out/'plants.u32',dtype='<u4').reshape(-1,3)
    mats=[]
    for photo_layer in [None,5,6,7,8]:
        mat,new,link=material('Meadow '+str(photo_layer));mats.append(mat)
        tint=new('ShaderNodeVertexColor');tint.layer_name='Source vertex pigment'
        al=tint.outputs['Color']
        if photo_layer is not None:
            tex=new('ShaderNodeTexImage');tex.image=leaf_texture(photo_layer,1.0)
            photo=tex.outputs['Color']
            if photo_layer in (7,8):
                # Reuse the live petal/forb desaturation rule on tinted source planes.
                split=new('ShaderNodeSeparateColor');link(al,split.inputs[0])
                tinted=new('ShaderNodeMath');tinted.operation='LESS_THAN';link(split.outputs[0],tinted.inputs[0]);tinted.inputs[1].default_value=.99
                fraction=new('ShaderNodeMath');fraction.operation='MULTIPLY';link(tinted.outputs[0],fraction.inputs[0]);fraction.inputs[1].default_value=.17
                y=new('ShaderNodeVectorMath');y.operation='DOT_PRODUCT';link(photo,y.inputs[0]);y.inputs[1].default_value=(.2126,.7152,.0722)
                mix=new('ShaderNodeMixRGB');link(fraction.outputs[0],mix.inputs[0]);link(photo,mix.inputs[1]);link(y.outputs['Value'],mix.inputs[2]);photo=mix.outputs[0]
            product=new('ShaderNodeVectorMath');product.operation='MULTIPLY'
            link(al,product.inputs[0]);link(photo,product.inputs[1]);al=product.outputs[0]
        else:
            product=new('ShaderNodeVectorMath');product.operation='SCALE';product.inputs['Scale'].default_value=.85
            link(al,product.inputs[0]);al=product.outputs[0]
        bsdf=new('ShaderNodeBsdfPrincipled');link(al,bsdf.inputs['Base Color']);bsdf.inputs['Roughness'].default_value=.66
        transmission=new('ShaderNodeBsdfTranslucent');ratio=new('ShaderNodeVectorMath');ratio.operation='SCALE';ratio.inputs['Scale'].default_value=.5*.96*transmission_scale
        link(al,ratio.inputs[0]);remaining=new('ShaderNodeVectorMath');remaining.operation='SUBTRACT';remaining.inputs[0].default_value=(.95,.95,.95);link(al,remaining.inputs[1])
        bounded=new('ShaderNodeVectorMath');bounded.operation='MINIMUM';link(remaining.outputs[0],bounded.inputs[0]);link(ratio.outputs[0],bounded.inputs[1]);link(bounded.outputs[0],transmission.inputs[0])
        both=new('ShaderNodeAddShader');link(bsdf.outputs[0],both.inputs[0]);link(transmission.outputs[0],both.inputs[1]);surf=both.outputs[0]
        if photo_layer is not None:
            norm=new('ShaderNodeTexImage');norm.image=normal_texture(photo_layer);bump=new('ShaderNodeNormalMap');bump.inputs['Strength'].default_value=.65
            link(norm.outputs['Color'],bump.inputs['Color']);link(bump.outputs[0],bsdf.inputs['Normal']);link(bump.outputs[0],transmission.inputs['Normal'])
            cut=new('ShaderNodeMixShader');link(tex.outputs['Alpha'],cut.inputs[0]);link(new('ShaderNodeBsdfTransparent').outputs[0],cut.inputs[1]);link(surf,cut.inputs[2]);surf=cut.outputs[0]
        link(surf,new('ShaderNodeOutputMaterial').inputs[0])
    codes=v[indices[:,0],9]
    tags=np.where(codes<6.5,0,np.clip(np.floor(codes+.1)-6,1,4))
    normal=blender_xyz(v[:,3:6]);normal/=np.maximum(np.linalg.norm(normal,axis=1,keepdims=True),1e-6)
    obj=mesh('Release meadow instances',blender_xyz(v[:,:3]),indices,mats,v[:,10:12],normal,tags)
    tint=obj.data.color_attributes.new(name='Source vertex pigment',type='FLOAT_COLOR',domain='POINT')
    colors=np.ones((len(v),4),dtype='f');colors[:,:3]=v[:,6:9]
    tint.data.foreach_set('color',colors.ravel())
ground_mat,new,link=material('Pasture bounce surface')
ground_bsdf=new('ShaderNodeBsdfDiffuse');ground_bsdf.inputs[0].default_value=(.054,.063,.014,1) if is_meadow else (.09,.135,.022,1)
# A camera-ray holdout supplies exact leaf coverage including depth occlusion
# by ground. The soil remains a full diffuse surface for all secondary rays.
hold=new('ShaderNodeMixShader');link(new('ShaderNodeLightPath').outputs['Is Camera Ray'],hold.inputs[0])
link(ground_bsdf.outputs[0],hold.inputs[1]);link(new('ShaderNodeHoldout').outputs[0],hold.inputs[2]);link(hold.outputs[0],new('ShaderNodeOutputMaterial').inputs[0])
s=fixture['groundSide'];g=[]
for j in range(s-1):
    for i in range(s-1):
        a=j*s+i;g.extend([[a,a+s,a+1],[a+1,a+s,a+s+1]])
ground=mesh('Local terrain for secondary rays',blender_xyz(fixture['ground']),g,[ground_mat])
bpy.ops.object.camera_add();camera=bpy.context.object;scene.camera=camera;camera.location=blender_xyz(fixture['position'])
camera.rotation_euler=Vector(blender_xyz(fixture['target'])-blender_xyz(fixture['position'])).to_track_quat('-Z','Y').to_euler()
camera.data.sensor_fit='VERTICAL';camera.data.sensor_height=24
camera.data.lens=12/math.tan(math.radians(fixture['verticalFov'])/2)

packed=np.fromfile(assets/'environment.bin',dtype='<u4').reshape(1024,2048)
def decode(channel,mantissa):
    exponent=(channel>>mantissa)&31;mant=channel&((1<<mantissa)-1)
    return np.where(exponent==0,np.ldexp(mant.astype('f'),1-15-mantissa),np.ldexp(1+mant.astype('f')/(1<<mantissa),exponent.astype('i')-15))
sky=np.stack([decode(packed,6),decode(packed>>11,6),decode(packed>>22,5)],axis=-1)
src_az=math.atan2(.3767307391,.5545620063)
# The measured solar flux is emitted by a finite-area distant sun below.
# Remove its 1 degree aperture from the HDR to avoid double counting.
y,x=np.ogrid[:1024,:2048];phi=((x+.5)/2048-.5)*2*np.pi;theta=(y+.5)/1024*np.pi
disk=np.cos(theta)*.7419804117+np.sin(theta)*(.5545620063*np.cos(phi)+.3767307391*np.sin(phi))>math.cos(math.radians(1))
sky[disk]=np.median(sky[235:245,1200:1207],axis=(0,1))
sky[512:]=0
scene.world=bpy.data.worlds.new('Rotated photographic sky');scene.world.use_nodes=True
world=scene.world.node_tree;env=world.nodes.new('ShaderNodeTexEnvironment');background=world.nodes.get('Background');world.links.new(env.outputs[0],background.inputs[0])
env.image=image('Resident HDR with separate solar disk',sky[::-1])
mapping=world.nodes.new('ShaderNodeVectorRotate');mapping.rotation_type='Z_AXIS';coords=world.nodes.new('ShaderNodeTexCoord')
world.links.new(coords.outputs['Generated'],mapping.inputs['Vector']);world.links.new(mapping.outputs['Vector'],env.inputs['Vector'])
sun=bpy.data.lights.new('Measured direct sun','SUN');sun.angle=math.radians(.53)
sun_obj=bpy.data.objects.new('Measured direct sun',sun);scene.collection.objects.link(sun_obj)
cloud=np.fromfile(assets/'cloud-transmittance.bin',dtype='u1').reshape(128,512)/255
def cloud_trans(sun_dir,az):
    height=ty+(.2 if is_meadow else 12)
    h=np.array([tx,height,tz])+sun_dir*((1330-height)/sun_dir[1])-[-170,245,210]
    u=(math.atan2(h[2],h[0])+src_az-az)/(2*np.pi)+.5
    v=math.acos(np.clip(h[1]/np.linalg.norm(h),0,1))*2/np.pi
    px=u*512-.5;pz=v*128-.5;i,j=math.floor(px),math.floor(pz)
    return sum(cloud[np.clip(j+dz,0,127),(i+dx)%512]*abs(1-dx-(px-i))*abs(1-dz-(pz-j)) for dx in (0,1) for dz in (0,1))
sun_el=math.radians(fixture['sunElevation'])
# Record source groups and interaction passes from exactly the same path
# samples, so attributing energy does not require subtracting noisy renders.
layer=scene.view_layers[0]
for kind in ('diffuse','glossy','transmission'):
    for term in ('color','direct','indirect'):setattr(layer,'use_pass_'+kind+'_'+term,True)
layer.lightgroups.add(name='Solar');layer.lightgroups.add(name='Sky')
sun_obj.lightgroup='Solar';scene.world.lightgroup='Sky'
scene.use_nodes=True;comp=scene.node_tree
layers=comp.nodes.get('Render Layers')
dump=comp.nodes.new('CompositorNodeOutputFile');dump.format.file_format='OPEN_EXR';dump.format.color_depth='32';dump.format.color_mode='RGB'
dump.file_slots.clear()
passes=['Combined_Solar','Combined_Sky','DiffCol','DiffDir','DiffInd','GlossCol','GlossDir','GlossInd','TransCol','TransDir','TransInd']
for name in passes:
    slot=dump.file_slots.new(name);comp.links.new(layers.outputs[name],slot)
for label,az in fixture['views'].items():
    dump.base_path=str(out/('passes-'+label))
    az=math.radians(az);direction=np.array([math.cos(sun_el)*math.cos(az),math.sin(sun_el),math.cos(sun_el)*math.sin(az)])
    mapping.inputs['Angle'].default_value=az-src_az
    direct=np.array([1.39009419,1.40065419,1.27155350])*np.exp(-np.array([.15,.23,.42])*(1/direction[1]-1/.741980412))
    sun.energy=direct.max()*np.pi*cloud_trans(direction,az);sun.color=(direct/direct.max()).tolist()
    sun_obj.rotation_euler=(-Vector(blender_xyz(direction))).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath=str(out/('cycles-'+label+'.exr'))
    bpy.ops.render.render(write_still=True)
    rendered=bpy.data.images.load(scene.render.filepath)
    pixels=np.empty(rendered.size[0]*rendered.size[1]*4,dtype='f')
    rendered.pixels.foreach_get(pixels)
    np.save(out/('cycles-'+label+'.npy'),pixels.reshape(rendered.size[1],rendered.size[0],4)[::-1])
    bpy.data.images.remove(rendered)
    print('Completed',label,spp,'samples,',len(indices),'triangles',flush=True)
