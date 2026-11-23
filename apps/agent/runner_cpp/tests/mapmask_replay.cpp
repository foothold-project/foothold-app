#include "foothold/ort_policy.hpp"

#include <iostream>
#include <stdexcept>

using namespace foothold;

namespace {
template<class T>
void read(T& values) {
    if (!std::cin.read(reinterpret_cast<char*>(values.data()), sizeof(float) * values.size()))
        throw std::runtime_error("incomplete map-mask replay input");
}

template<class T>
void write(const T& values) {
    std::cout.write(reinterpret_cast<const char*>(values.data()), sizeof(float) * values.size());
}
}

int main(int argc, char** argv) {
    try {
        if (argc != 2) throw std::invalid_argument("usage: mapmask_replay BUNDLE");
        OrtPolicy policy(argv[1], MapMode::automatic);
        Pose pose;
        read(pose);
        Memory memory(MapMode::automatic, pose);
        Obs obs;
        Depth frame;
        Outputs out;
        for (int available; (available = std::cin.get()) != EOF;) {
            if (available != 0 && available != 1) throw std::runtime_error("invalid depth flag");
            read(obs);
            if (available) read(frame);
            memory.update_map(available != 0);
            policy.infer(memory.prepare(obs, available && memory.depth_needed() ? &frame : nullptr), out);
            memory.advance(out.h_prop, out.h_terr);
            write(out.action);
            write(out.h_prop);
            write(out.h_terr);
            write(out.recon);
            write(out.est);
        }
        if (!std::cout.flush()) throw std::runtime_error("map-mask replay write failed");
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
