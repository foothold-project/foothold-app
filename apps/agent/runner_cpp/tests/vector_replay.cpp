#include "foothold/ort_policy.hpp"

#include <iostream>
#include <stdexcept>

using namespace foothold;

namespace {
template<class T>
void read(T& values) {
    if (!std::cin.read(reinterpret_cast<char*>(values.data()), sizeof(float) * values.size()))
        throw std::runtime_error("incomplete replay input");
}
}

int main(int argc, char** argv) {
    try {
        if (argc != 3) throw std::invalid_argument("usage: vector_replay BUNDLE MODE");
        const auto mode = parse_map_mode(argv[2]);
        OrtPolicy policy(argv[1], mode);
        Memory memory(mode);
        Obs obs;
        Depth depth;
        HeightMap gt;
        Outputs out;
        for (int step = 0; step < 20; ++step) {
            read(obs);
            const bool depth_tick = memory.depth_needed();
            if (depth_tick) read(depth);
            if (mode == MapMode::gt) read(gt);
            policy.infer(memory.prepare(obs, depth_tick ? &depth : nullptr,
                                        mode == MapMode::gt ? &gt : nullptr), out);
            memory.advance(out.h_prop, out.h_terr);
            std::cout.write(reinterpret_cast<const char*>(out.action.data()), sizeof out.action);
        }
        if (std::cin.peek() != EOF || !std::cout.flush())
            throw std::runtime_error("unexpected replay stream length");
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
