package room;

import java.util.*;

/** A single similarity transform keeps trained splats and collision surfaces aligned. */
public final class Normalization {
    public record Point(double x, double y, double z) {
        public Point {
            if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)) throw new IllegalArgumentException("Coordinates must be finite");
        }
        Point sub(Point b) { return new Point(x-b.x, y-b.y, z-b.z); }
        Point mul(double s) { return new Point(x*s, y*s, z*s); }
        double dot(Point b) { return x*b.x+y*b.y+z*b.z; }
        Point cross(Point b) { return new Point(y*b.z-z*b.y, z*b.x-x*b.z, x*b.y-y*b.x); }
        double length() { return Math.sqrt(dot(this)); }
        Point unit() { double l = length(); if (l < 1e-6) throw new IllegalArgumentException("Choose distinct points"); return mul(1/l); }
        List<Double> list() { return List.of(x,y,z); }
    }
    public record Obstacle(Point a, Point b) {}
    public record Dimension(String id, String name, Point a, Point b) {}
    public record Calibration(List<Point> measurement, double meters, List<Point> floor, List<Point> boundary,
                              Point spawn, boolean flipUp, boolean reviewed, List<Obstacle> obstacles, List<Dimension> dimensions) {}
    public static Map<String, Object> apply(Calibration c, Point cameraPosition) {
        if (c.measurement() == null || c.measurement().size()!=2 || c.floor()==null || c.floor().size()!=3 || c.boundary()==null || c.boundary().size()<3 || c.boundary().size()>128 || c.spawn()==null || !c.reviewed())
            throw new IllegalArgumentException("Select two measurement points, three floor points, a boundary, a spawn and confirm collision review");
        if (!Double.isFinite(c.meters()) || c.meters()<0.05 || c.meters()>100) throw new IllegalArgumentException("Measured distance must be between 0.05 and 100 meters");
        double scale = c.meters()/c.measurement().get(1).sub(c.measurement().get(0)).length();
        if (!Double.isFinite(scale) || scale<1e-6 || scale>1e6) throw new IllegalArgumentException("Invalid scale");
        if (c.dimensions()!=null) {
            if (c.dimensions().size()>100) throw new IllegalArgumentException("Save at most 100 room dimensions");
            var ids=new HashSet<String>();
            for (var dimension:c.dimensions()) {
                if (dimension==null || dimension.id()==null || dimension.id().length()>100 || !ids.add(dimension.id()) || dimension.name()==null || dimension.name().isBlank() || dimension.name().length()>80 || dimension.a()==null || dimension.b()==null)
                    throw new IllegalArgumentException("Give each room dimension a name and two endpoints");
                double length=dimension.b().sub(dimension.a()).length()*scale;
                if (length<0.001 || length>1000) throw new IllegalArgumentException("Room dimension endpoints must be separate and inside the room");
            }
        }
        Point origin=c.floor().get(0), forward=c.floor().get(1).sub(origin).unit();
        Point up=forward.cross(c.floor().get(2).sub(origin)).unit();
        if (up.dot(cameraPosition.sub(origin)) < 0) up=up.mul(-1);
        if (c.flipUp()) up=up.mul(-1);
        Point back=forward.mul(-1), right=up.cross(back).unit();
        final Point vertical=up;
        java.util.function.Function<Point,Point> transform=p -> { var q=p.sub(origin); return new Point(scale*right.dot(q),scale*vertical.dot(q),scale*back.dot(q)); };
        Point translation=transform.apply(new Point(0,0,0));
        var matrix=List.of(scale*right.x,scale*up.x,scale*back.x,0.0,scale*right.y,scale*up.y,scale*back.y,0.0,scale*right.z,scale*up.z,scale*back.z,0.0,translation.x,translation.y,translation.z,1.0);
        var boundary = c.boundary().stream().map(transform).toList();
        for (Point p:boundary) if (Math.abs(p.y)>0.15) throw new IllegalArgumentException("Boundary points must lie on the selected floor");
        var polygon=boundary.stream().map(p -> List.of(p.x,p.z)).toList();
        double area=0; for(int i=0;i<boundary.size();i++) { Point a=boundary.get(i), b=boundary.get((i+1)%boundary.size()); area+=a.x*b.z-b.x*a.z; }
        if(Math.abs(area)<0.5) throw new IllegalArgumentException("Walkable boundary is too small");
        for(int i=0;i<boundary.size();i++) for(int j=i+1;j<boundary.size();j++) {
            if(j==i+1 || (i==0 && j==boundary.size()-1)) continue;
            if(intersects(boundary.get(i),boundary.get((i+1)%boundary.size()),boundary.get(j),boundary.get((j+1)%boundary.size()))) throw new IllegalArgumentException("Boundary must not cross itself");
        }
        Point spawn=transform.apply(c.spawn());
        boolean inside=false;
        for(int i=0,j=boundary.size()-1;i<boundary.size();j=i++) {
            Point a=boundary.get(i), b=boundary.get(j);
            if ((a.z>spawn.z)!=(b.z>spawn.z) && spawn.x<(b.x-a.x)*(spawn.z-a.z)/(b.z-a.z)+a.x) inside=!inside;
        }
        if(!inside || Math.abs(spawn.y)>0.15) throw new IllegalArgumentException("Spawn must be inside the floor boundary");
        var boxes=new ArrayList<Map<String,Object>>();
        if(c.obstacles()!=null) {
            if(c.obstacles().size()>100) throw new IllegalArgumentException("Too many obstacles");
            for(var box:c.obstacles()) {
                var a=transform.apply(box.a()); var b=transform.apply(box.b());
                var size=new Point(Math.abs(a.x-b.x),Math.abs(a.y-b.y),Math.abs(a.z-b.z));
                if(size.x<0.01 || size.y<0.01 || size.z<0.01) throw new IllegalArgumentException("An obstacle needs width, depth and height");
                boxes.add(Map.of("center",List.of((a.x+b.x)/2,(a.y+b.y)/2,(a.z+b.z)/2),"size",size.list()));
            }
        }
        var navigation=Map.of("floorY",0,"boundary",polygon,"spawn",List.of(spawn.x,0.0,spawn.z),"yaw",0,"eyeHeight",1.65,"speed",1.5,"capsuleRadius",0.25,"capsuleHeight",1.75,"obstacles",boxes);
        return Map.of("worldFromReconstruction",matrix,"navigation",navigation,"scaleProvenance",Map.of("method","measured-distance","meters",c.meters(),"reconstructionDistance",c.measurement().get(1).sub(c.measurement().get(0)).length()),"collisionReviewed",true);
    }
    private static double side(Point a,Point b,Point c) { return (b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x); }
    private static boolean intersects(Point a,Point b,Point c,Point d) { return side(a,b,c)*side(a,b,d)<=0 && side(c,d,a)*side(c,d,b)<=0 && Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))<=Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x)) && Math.max(Math.min(a.z,b.z),Math.min(c.z,d.z))<=Math.min(Math.max(a.z,b.z),Math.max(c.z,d.z)); }
}
